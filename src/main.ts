import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, screen, Notification, powerMonitor } from 'electron';
app.setName('Action Auto CRM Tray-App');
import path from 'path';
import http from 'http';
import axios from 'axios';
import dotenv from 'dotenv';
import { autoUpdater } from 'electron-updater';

// Check for updates silently in the background. This is a tray-only app that
// is designed to stay running for days without a manual restart, so checking
// once at launch isn't enough — it re-checks periodically below — and once an
// update is downloaded it installs and relaunches itself rather than waiting
// for the user to quit, since that quit may never naturally happen.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null;

// Real-time detection now comes from the backend pushing 'tray:check-update'
// over the socket the moment a release is published (see connectSocket call
// in startAgentServices) — this interval is just a backstop for a tray that
// happened to be offline/disconnected when that push fired, so it doesn't
// need to be aggressive and doesn't add to GitHub API rate-limit pressure.
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000; // backstop: re-check every 30 minutes

autoUpdater.on('update-downloaded', () => {
  if (Notification.isSupported()) {
    new Notification({
      title: 'Update ready',
      body: 'A new version of Action Auto Tray was downloaded and will install automatically in a few seconds.',
      silent: true,
    }).show();
  }
  // Give the notification a moment to render, then apply the update ourselves —
  // silent install, auto-relaunch — so no manual close/reopen is needed, even
  // while the user is actively clocked in. Flush whatever's been tracked since
  // the last checkpoint FIRST — quitAndInstall terminates the process, and
  // without this the in-memory-only active segment would be silently lost,
  // same failure mode as an unexpected crash.
  setTimeout(async () => {
    if (activityStartMs !== null) {
      await commitActiveSegment(new Date());
    }
    autoUpdater.quitAndInstall(true, true);
  }, 10_000);
});
// In a packaged build, .env lives in extraResources (process.resourcesPath).
// In dev, it lives at the project root (one level above dist/).
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '..', '.env');
dotenv.config({ path: envPath });
import { connectSocket, disconnectSocket, updateSocketToken } from './socket';
import { startIdleMonitor, stopIdleMonitor } from './idle';
import { startHeartbeat, stopHeartbeat, pingHeartbeat, setHeartbeatPath, updateHeartbeatToken } from './heartbeat';
import { startScreenshots, stopScreenshots, isScreenshotRunning, captureAndUploadOnce, setCaptureFailedCallback, setOnBreakGetter, setSkipCaptures } from './screenshot';
import { flushQueue } from './offline-queue';
import { startCallStatePolling, stopCallStatePolling, getCurrentCall, ActiveCallState } from './call-state';
import { startRecording, stopRecording, getRecordingStatus, registerRecordingIpcHandlers, destroyRecorderWindow } from './recording';
import { initTranscription, resetTranscript, getFullTranscript, processAudioChunk } from './transcription';
import { io as ioClient, Socket as TraySocket } from 'socket.io-client';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AutoLaunch = require('auto-launch') as new (opts: { name: string; isHidden: boolean }) => { enable: () => void };

type StoreInstance = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
};
// electron-store v11 is ESM-only; use require for CommonJS compatibility
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Store = require('electron-store').default;
const store = new Store({ encryptionKey: 'aa-tray-secure-key' }) as StoreInstance;

/* ─────────────────────────────────────────────────────────────────
   Auth-mode helpers — 'crm' uses /api/crm/* endpoints,
   'main' uses /api/timeclock/* endpoints (Clerk/main-system JWT)
───────────────────────────────────────────────────────────────── */
const getAuthMode = (): 'crm' | 'main' => (store.get('auth_mode') as 'crm' | 'main') || 'crm';
const getShiftStateUrl  = () => getAuthMode() === 'main' ? '/api/timeclock/shift-state'      : '/api/crm/timeproof/shift-state';
const getActivityIntervalUrl = () => getAuthMode() === 'main' ? '/api/timeclock/activity-interval' : '/api/crm/timeproof/activity-interval';
const getResumableShiftUrl   = () => getAuthMode() === 'main' ? '/api/timeclock/resumable-shift'   : '/api/crm/timeproof/resumable-shift';
const getClockUrl            = () => getAuthMode() === 'main' ? '/api/timeclock/clock'             : '/api/crm/time-clock';

/* ─────────────────────────────────────────────────────────────────
   Config
───────────────────────────────────────────────────────────────── */
const CRM_URL = process.env.CRM_URL || 'https://your-crm-url.com/crm';
const API_URL = process.env.API_URL || 'https://your-api-url.com';

const autoLauncher = new AutoLaunch({ name: 'Action Auto Tray', isHidden: true });

/* ─────────────────────────────────────────────────────────────────
   State
───────────────────────────────────────────────────────────────── */
interface User {
  fullName: string;
  username: string;
  role: string;
  screenshotExempt?: boolean;
}

interface AgentState {
  isAuthenticated: boolean;
  user: User | null;
  isOnShift: boolean;
  isOnBreak: boolean;
  isIdle: boolean;
  isAgentOnline: boolean;
  shiftStartedAt: string | null;
  breakStartedAt: string | null;
  nextScreenshotIn: string | null;
  totalBreakSeconds: number;
  todayTotalWorkedSeconds: number;
  // Activity-based tracking (idle-aware timer)
  activityStartMs: number | null;
  todayTotalActiveMs: number;
  // Authoritative rendered-hours baseline — same wall-clock (TimeLog-based)
  // figure that powers the CRM's Today card / calendar, which never suffers
  // the "resets to zero" bug the activityStartMs-based timer above is prone
  // to. The renderer should display THIS, ticking from wallClockBaseAt.
  wallClockBaseMs: number;
  wallClockBaseAt: number | null;
}

let tray: Tray | null = null;
let statusWindow: BrowserWindow | null = null;
let autrixWindow: BrowserWindow | null = null;
let traySocket: TraySocket | null = null;

let breakNotifyIntervalId: ReturnType<typeof setInterval> | null = null;
let resyncIntervalId: ReturnType<typeof setInterval> | null = null;
let autoClockoutCheckIntervalId: ReturnType<typeof setInterval> | null = null;
let breakExceededNotified = false;
let autoClockoutTriggeredForThisIdleStretch = false;

// Rendered hours (net of breaks) a shift must already have before either
// auto-clock-out trigger below (idle timeout or sleep/shutdown) becomes
// active — a shift that hasn't reached this yet is left alone even if the
// machine goes idle or to sleep.
const AUTO_CLOCKOUT_RENDERED_HOURS_MS = 8 * 60 * 60 * 1000;
const AUTO_CLOCKOUT_IDLE_MS = 30 * 60 * 1000;

/**
 * Rendered (active, break-excluded) milliseconds for the current shift so
 * far — uses the authoritative wall-clock baseline (same figure backing the
 * CRM's Today card), not the activityStartMs/todayTotalActiveMs pair, since
 * auto-clockout decisions below depend on this crossing the 8h threshold
 * correctly and that pair has repeatedly been found to under-report after
 * a failed checkpoint, stale heartbeat, or idle-detection flap.
 */
const getRenderedMsSoFar = (): number =>
  wallClockBaseMs + (wallClockBaseAt !== null ? Date.now() - wallClockBaseAt : 0);

// Activity-based time tracking (idle-aware) — still used for ActivityInterval
// commits (idle log / monitoring) and screenshot gating, just no longer as
// the basis for the displayed timer or auto-clockout hour-threshold checks.
let activityStartMs: number | null = null;  // when current active period began (local clock)
let todayTotalActiveMs: number = 0;         // sum of completed active interval durations

// Authoritative wall-clock baseline — see AgentState.wallClockBaseMs/wallClockBaseAt.
let wallClockBaseMs: number = 0;
let wallClockBaseAt: number | null = null;

let agentState: AgentState = {
  isAuthenticated: false,
  user: null,
  isOnShift: false,
  isOnBreak: false,
  isIdle: false,
  isAgentOnline: false,
  shiftStartedAt: null,
  breakStartedAt: null,
  nextScreenshotIn: null,
  totalBreakSeconds: 0,
  todayTotalWorkedSeconds: 0,
  activityStartMs: null,
  todayTotalActiveMs: 0,
  wallClockBaseMs: 0,
  wallClockBaseAt: null,
};

/* ─────────────────────────────────────────────────────────────────
   State broadcast helpers
───────────────────────────────────────────────────────────────── */
const STATUS_HEIGHT_BASE = 400;
const STATUS_HEIGHT_CALL = 468;

const broadcastState = () => {
  if (statusWindow && !statusWindow.isDestroyed()) {
    const callState = getCurrentCall();
    const targetH = callState ? STATUS_HEIGHT_CALL : STATUS_HEIGHT_BASE;
    const [currentW, currentH] = statusWindow.getSize();
    if (currentH !== targetH) {
      const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
      statusWindow.setSize(currentW, targetH);
      statusWindow.setPosition(screenW - currentW - 16, screenH - targetH - 16);
    }
    statusWindow.webContents.send('status:update', {
      ...agentState,
      activeCall: callState ? {
        meetingId: callState.meetingId,
        title: callState.title,
        canRecord: callState.canRecord,
        isRecording: getRecordingStatus() === 'recording',
      } : null,
    });
  }
  updateTrayIcon();
  tray?.setContextMenu(buildTrayMenu());
};

/* ─────────────────────────────────────────────────────────────────
   Tray icon helpers
───────────────────────────────────────────────────────────────── */
const getTrayIcon = () => {
  // Use activityStartMs as fallback — same logic as status.html's effectivelyOnShift
  const effectivelyOnShift = agentState.isOnShift || activityStartMs !== null;
  const iconName = agentState.isAgentOnline
    ? effectivelyOnShift
      ? agentState.isIdle ? 'tray-idle.png' : 'tray-active.png'
      : 'tray-offline.png'
    : 'tray-offline.png';

  const iconPath = path.join(__dirname, '..', 'assets', iconName);
  try {
    return nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    return nativeImage.createEmpty();
  }
};

const updateTrayIcon = () => {
  if (!tray) return;
  tray.setImage(getTrayIcon());

  const effectivelyOnShift = agentState.isOnShift || activityStartMs !== null;
  const tooltip = agentState.isAuthenticated
    ? effectivelyOnShift
      ? agentState.isIdle
        ? `Action Auto — Idle (${agentState.user?.fullName})`
        : `Action Auto — On Shift (${agentState.user?.fullName})`
      : agentState.isOnBreak
      ? `Action Auto — On Break (${agentState.user?.fullName})`
      : `Action Auto — ${agentState.user?.fullName}`
    : 'Action Auto Tray — Not signed in';

  tray.setToolTip(tooltip);
};

const buildTrayMenu = () => {
  const items: Electron.MenuItemConstructorOptions[] = [];

  if (agentState.isAuthenticated && agentState.user) {
    const effectivelyOnShift = agentState.isOnShift || activityStartMs !== null;
    items.push({ label: agentState.user.fullName, enabled: false });
    items.push({
      label: effectivelyOnShift
        ? agentState.isIdle ? '⚪ Idle' : '🟢 On Shift'
        : agentState.isOnBreak ? '☕ On Break' : '⚫ Not Clocked In',
      enabled: false,
    });
    items.push({ type: 'separator' });
    items.push({ label: 'Open CRM', click: () => shell.openExternal(CRM_URL) });

    // ── Call / recording items (only when in an active call) ───────────────
    const activeCall = getCurrentCall();
    if (activeCall) {
      items.push({ type: 'separator' });
      items.push({ label: `In Call: ${activeCall.title || 'Meeting'}`, enabled: false });

      if (activeCall.canRecord) {
        const recStatus = getRecordingStatus();
        if (recStatus === 'idle') {
          items.push({
            label: '⏺ Start Recording',
            click: () => handleStartRecording(activeCall),
          });
        } else if (recStatus === 'recording') {
          items.push({
            label: '⏹ Stop & Save Recording',
            click: handleStopRecording,
          });
        } else {
          items.push({ label: '⏳ Saving recording…', enabled: false });
        }
      }

      items.push({
        label: '✦ Open Autrix AI',
        click: showAutrixWindow,
      });
    }

    items.push({ type: 'separator' });
    items.push({ label: 'Sign Out', click: handleLogout });
  } else {
    items.push({ label: 'Open Dashboard to Sign In', click: () => shell.openExternal(CRM_URL) });
  }

  items.push({ type: 'separator' });
  items.push({ label: 'Quit', click: () => app.quit() });

  return Menu.buildFromTemplate(items);
};

/* ─────────────────────────────────────────────────────────────────
   Windows
───────────────────────────────────────────────────────────────── */
const createStatusWindow = () => {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  statusWindow = new BrowserWindow({
    width: 300,
    height: 400,
    x: width - 316,
    y: height - 416,
    resizable: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  statusWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'status.html'));
  statusWindow.on('blur', () => statusWindow?.hide());
  statusWindow.on('closed', () => { statusWindow = null; });
};

/* ─────────────────────────────────────────────────────────────────
   Autrix AI window
───────────────────────────────────────────────────────────────── */
const createAutrixWindow = () => {
  const display = screen.getPrimaryDisplay();
  const { width } = display.workAreaSize;

  autrixWindow = new BrowserWindow({
    width: 320,
    height: 520,
    x: width - 336,
    y: 60,
    resizable: true,
    minWidth: 280,
    minHeight: 400,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: 'Autrix AI',
    webPreferences: {
      preload: path.join(__dirname, 'autrix-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  autrixWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'autrix.html'));
  autrixWindow.on('closed', () => { autrixWindow = null; });
};

const showAutrixWindow = () => {
  if (!autrixWindow || autrixWindow.isDestroyed()) createAutrixWindow();
  autrixWindow?.show();
  autrixWindow?.focus();
};

/* ─────────────────────────────────────────────────────────────────
   Tray socket — real-time commands from backend (recording triggers)
───────────────────────────────────────────────────────────────── */
const connectTraySocket = (token: string) => {
  if (traySocket?.connected) return;
  if (traySocket) { traySocket.removeAllListeners(); traySocket.disconnect(); }

  traySocket = ioClient(API_URL, {
    path: '/socket/supraspace',
    auth: { token },
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 3000,
    reconnectionDelayMax: 15_000,
    transports: ['websocket', 'polling'],
  });

  traySocket.on('connect', () => {
    console.log('[Tray Socket] Connected:', traySocket?.id);
  });

  traySocket.on('tray:start-recording', () => {
    const call = getCurrentCall();
    if (call && call.canRecord) handleStartRecording(call);
  });

  traySocket.on('tray:stop-recording', () => {
    handleStopRecording();
  });

  traySocket.on('disconnect', (reason) => {
    console.log('[Tray Socket] Disconnected:', reason);
  });

  traySocket.on('connect_error', (err) => {
    console.warn('[Tray Socket] Connection error:', err.message);
  });
};

const disconnectTraySocket = () => {
  if (traySocket) {
    traySocket.removeAllListeners();
    traySocket.disconnect();
    traySocket = null;
  }
};

/* ─────────────────────────────────────────────────────────────────
   Recording handlers
───────────────────────────────────────────────────────────────── */
const handleStartRecording = (call: ActiveCallState) => {
  const token = store.get('crm_token') as string | undefined;
  if (!token) return;

  resetTranscript();
  initTranscription(API_URL, token, (text) => {
    // Push transcript updates to the Autrix window if it's open
    if (autrixWindow && !autrixWindow.isDestroyed()) {
      autrixWindow.webContents.send('autrix:transcript-update', text);
    }
  });

  startRecording(call.meetingId, {
    onStatusChange: () => { tray?.setContextMenu(buildTrayMenu()); broadcastState(); },
    onChunkReady: (audioBuffer, chunkIndex) => {
      processAudioChunk(audioBuffer, chunkIndex).catch(() => {});
    },
  }).catch(() => {});
};

const handleStopRecording = () => {
  stopRecording().then(() => {
    tray?.setContextMenu(buildTrayMenu());
    broadcastState();
    if (autrixWindow && !autrixWindow.isDestroyed()) {
      autrixWindow.webContents.send('autrix:call-ended');
    }
  }).catch(() => {});
};

const showStatusWindow = () => {
  if (!statusWindow || statusWindow.isDestroyed()) createStatusWindow();
  if (statusWindow) {
    statusWindow.webContents.send('status:update', agentState);
    statusWindow.show();
    statusWindow.focus();
    // Re-sync from server every time the popup opens so the user always sees
    // live state even if a socket event (clock-in/out from CRM web) was missed.
    const currentToken = store.get('crm_token') as string | undefined;
    if (currentToken && agentState.isAuthenticated) {
      syncShiftState(currentToken);
    }
  }
};

/* ─────────────────────────────────────────────────────────────────
   Agent services — start/stop on login/logout
───────────────────────────────────────────────────────────────── */
/**
 * Tries to renew the stored CRM JWT before it expires.
 * Returns the new token on success, null on failure (token expired or network error).
 */
const tryRefreshToken = async (token: string): Promise<string | null> => {
  try {
    const { data } = await axios.post(
      `${API_URL}/api/crm/token-refresh`,
      {},
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 }
    );
    const newToken: string = data?.data?.token;
    if (newToken) {
      store.set('crm_token', newToken);
      return newToken;
    }
    return null;
  } catch {
    return null;
  }
};

const syncShiftState = async (token: string, retries = 3): Promise<void> => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.get(`${API_URL}${getShiftStateUrl()}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10_000,
      });
      const s = data?.data;
      if (!s) return;
      // Trust the backend's isOnShift for display so the tray UI matches the CRM and
      // does not desync when a shift crosses MDT midnight or runs slightly long. The
      // original "isShiftFromToday" guard incorrectly hid legitimate ongoing shifts
      // that started yesterday MDT, causing "already clocked in" errors when the user
      // tried to click Start Shift again on a tray that wrongly showed "Off Shift".
      //
      // For genuine forgotten clock-outs (shift older than ~16 hours), we still avoid
      // auto-starting activity tracking — but the user sees the on-shift state and
      // can press End Shift to close it cleanly.
      const STALE_SHIFT_MS = 16 * 60 * 60 * 1000;
      const elapsedMs = s.shiftStartedAt
        ? Date.now() - new Date(s.shiftStartedAt).getTime()
        : 0;
      const isStaleShift = !!s.isOnShift && elapsedMs > STALE_SHIFT_MS;

      agentState.isOnShift              = !!s.isOnShift;
      agentState.isOnBreak              = s.isOnShift ? !!s.isOnBreak : false;
      agentState.shiftStartedAt         = s.isOnShift ? (s.shiftStartedAt ?? null) : null;
      agentState.breakStartedAt         = s.isOnShift ? (s.breakStartedAt ?? null) : null;
      agentState.totalBreakSeconds      = s.isOnShift ? (s.totalBreakSeconds ?? 0) : 0;
      agentState.todayTotalWorkedSeconds = s.todayTotalWorkedSeconds ?? 0;
      // Authoritative wall-clock baseline for display + auto-clockout hour
      // checks (see getRenderedMsSoFar) — always correct, TimeLog-based, so
      // it never suffers the reset/freeze bugs the activityStartMs pair below
      // has repeatedly hit.
      wallClockBaseMs = (s.wallClockRenderedSeconds ?? 0) * 1000;
      wallClockBaseAt = (s.isOnShift && !s.isOnBreak) ? Date.now() : null;
      agentState.wallClockBaseMs = wallClockBaseMs;
      agentState.wallClockBaseAt = wallClockBaseAt;
      // Activity-based tracking: pull the authoritative completed-interval total from the server.
      // We do NOT restore activityStartMs from currentIntervalStartAt because that value could
      // be stale (written before a restart) and would inflate the timer with offline time.
      // The live interval start is managed locally and reset fresh on each app session.
      todayTotalActiveMs = (s.todayTotalActiveSeconds ?? 0) * 1000;
      agentState.todayTotalActiveMs = todayTotalActiveMs;

      // If activityStartMs is from before today's MDT midnight it's a stale carry-over
      // from a shift that ran across midnight. Reset it so the tray timer doesn't display
      // yesterday's elapsed time (e.g. 12+ hours) as today's work time.
      // The COMPANY_TZ_OFFSET_MINUTES constant is defined on the backend (UTC-6 = -360 min).
      // We replicate the same arithmetic here: MDT midnight = today's UTC midnight + 6h.
      const MDT_OFFSET_MS = -6 * 60 * 60 * 1000; // UTC-6
      const nowInMDT = new Date(Date.now() + MDT_OFFSET_MS);
      const todayMDTDateStr = nowInMDT.toISOString().split('T')[0];
      const todayMDTMidnightUTC = new Date(todayMDTDateStr + 'T00:00:00.000Z').getTime() - MDT_OFFSET_MS;
      if (activityStartMs !== null && activityStartMs < todayMDTMidnightUTC) {
        activityStartMs = null;
        agentState.activityStartMs = null;
        stopScreenshots();
        agentState.nextScreenshotIn = null;
      }

      // Reconcile activity tracking with authoritative server state.
      // Socket event handlers handle real-time transitions; syncShiftState
      // patches missed socket events (missed break-in, missed time-out).
      // For stale shifts (forgotten clock-outs > 16h) we still surface on-shift
      // status in the UI but skip auto-starting the activity counter — the user
      // must explicitly end the old shift to start a fresh one.
      const isNowTracking = agentState.isOnShift && !agentState.isOnBreak && !agentState.isIdle && !isStaleShift;

      if (agentState.isOnShift && agentState.isOnBreak && activityStartMs !== null) {
        // CONFIRMED on break but local interval is still running → missed break-in event.
        // Flush the interval up to when the break started so work time is preserved.
        const stopAt = agentState.breakStartedAt
          ? new Date(agentState.breakStartedAt).getTime()
          : Date.now();
        const durationMs = Math.max(0, stopAt - activityStartMs);
        const tkn = store.get('crm_token') as string | undefined;
        if (tkn && durationMs >= 30_000) {
          axios.post(
            `${API_URL}${getActivityIntervalUrl()}`,
            { startAt: new Date(activityStartMs).toISOString(), endAt: new Date(stopAt).toISOString() },
            { headers: { Authorization: `Bearer ${tkn}` }, timeout: 10_000 }
          ).then(() => {
            todayTotalActiveMs += durationMs;
            agentState.todayTotalActiveMs = todayTotalActiveMs;
            broadcastState();
          }).catch(() => {});
        }
        activityStartMs = null;
        agentState.activityStartMs = null;
        stopScreenshots();
        agentState.nextScreenshotIn = null;
      } else if (!agentState.isOnShift && activityStartMs !== null) {
        // Server confirms off-shift (clocked out) but local timer is still running.
        // This happens when the time-out socket event was missed.
        // The socket handler already committed the interval — just clear the local state.
        activityStartMs = null;
        agentState.activityStartMs = null;
        stopScreenshots();
        agentState.nextScreenshotIn = null;
      } else if (isNowTracking && activityStartMs === null) {
        // Active but no local interval. Auto-resume tracking when:
        //  (a) shift started < 5 min ago — covers the "user just clicked Start Shift
        //      in the CRM, then the tray opens/syncs" handoff, OR
        //  (b) shift is from TODAY (MDT) — covers tray restarts during an active shift
        //      (crash, auto-update, system reboot). The idle monitor handles mid-session
        //      pauses; syncShiftState must handle the cold-start case.
        //
        // Shifts from a PREVIOUS day that were never clocked out are left paused —
        // the user sees "Shift Open — Tap Resume" and can close or resume explicitly.
        const SHIFT_AUTO_RESUME_MS = 5 * 60 * 1000;
        const shiftStartedAtMs = agentState.shiftStartedAt
          ? new Date(agentState.shiftStartedAt).getTime() : 0;
        const shiftStartedRecently = shiftStartedAtMs > 0
          && (Date.now() - shiftStartedAtMs) < SHIFT_AUTO_RESUME_MS;
        const isFromToday = !!s.isShiftFromToday;

        if (shiftStartedRecently || isFromToday) {
          const serverIntervalStart = s.currentIntervalStartAt
            ? new Date(s.currentIntervalStartAt).getTime() : null;
          if (serverIntervalStart && serverIntervalStart >= shiftStartedAtMs && serverIntervalStart <= Date.now()) {
            activityStartMs = serverIntervalStart;
          } else {
            activityStartMs = Date.now();
          }
          agentState.activityStartMs = activityStartMs;
          startScreenshots(API_URL, token);
        }
        // else: shift from a previous day with no recent tracking — show "Shift Open — Tap Resume"
      } else {
        agentState.activityStartMs = activityStartMs;
      }

      // Watchdog: if we should be tracking (on shift, not on break, not idle,
      // activityStartMs is set) but the screenshot interval has silently died
      // (socket reconnect, edge-case stopScreenshots call, etc.), restart it.
      // syncShiftState runs every 60s so any gap is self-healed within a minute.
      if (isNowTracking && activityStartMs !== null && !isScreenshotRunning()) {
        startScreenshots(API_URL, token);
        agentState.nextScreenshotIn = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      }

      broadcastState();
      return;
    } catch {
      if (attempt < retries) {
        // Wait 3s before retrying so transient network hiccups don't leave
        // the tray showing "Not Clocked In" when the user is actually on shift
        await new Promise(resolve => setTimeout(resolve, 3_000));
      }
    }
  }
  // All retries failed — socket events will eventually correct the state
};

let tokenRefreshIntervalId: ReturnType<typeof setInterval> | null = null;
let activityCheckpointIntervalId: ReturnType<typeof setInterval> | null = null;
const ACTIVITY_CHECKPOINT_MS = 10 * 60 * 1000;

/**
 * Commits the current active segment (activityStartMs → endAt) as a saved
 * ActivityInterval and folds its duration into todayTotalActiveMs. Used both
 * when the user goes idle AND by the periodic checkpoint below — without a
 * periodic checkpoint, a long continuous active stretch lives only in this
 * process's memory until it ends, so an unexpected tray restart (crash,
 * auto-update relaunch, forced quit) loses the entire stretch instead of
 * just the last few minutes since the last checkpoint.
 */
/**
 * Returns true if the segment was committed (or there was nothing to commit /
 * it was too short to matter) — false only when the POST itself failed. Callers
 * that roll activityStartMs forward MUST check this return value: rolling
 * forward unconditionally after a failed commit silently discards that chunk
 * of time forever (the next checkpoint would start counting from the new,
 * later point instead of retrying the un-committed duration).
 */
const commitActiveSegment = async (endAt: Date): Promise<boolean> => {
  if (activityStartMs === null) return true;
  const currentToken = store.get('crm_token') as string | undefined;
  const durationMs = endAt.getTime() - activityStartMs;
  if (!currentToken || durationMs < 30_000) return true;
  try {
    await axios.post(
      `${API_URL}${getActivityIntervalUrl()}`,
      { startAt: new Date(activityStartMs).toISOString(), endAt: endAt.toISOString() },
      { headers: { Authorization: `Bearer ${currentToken}` }, timeout: 10_000 }
    );
    todayTotalActiveMs += durationMs;
    agentState.todayTotalActiveMs = todayTotalActiveMs;
    return true;
  } catch {
    return false;
  }
};

const startAgentServices = async (token: string) => {
  const SCREENSHOT_INTERVAL_MS = 10 * 60 * 1000;
  const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 60 * 1000; // 10 hours — renew before 12h expiry

  // Configure endpoint paths and screenshot mode based on auth mode
  const authMode = getAuthMode();
  if (authMode === 'main') {
    setHeartbeatPath('/api/timeclock/heartbeat');
    setSkipCaptures(true); // screenshots not yet supported for main-mode users
  } else {
    setHeartbeatPath('/api/crm/timeproof/heartbeat');
    // Admin-granted per-user exemption (CrmUser.screenshotExempt) — takes
    // effect on next login/reconnect with a fresh token, same as other
    // account-level fields, since we don't re-fetch /api/crm/me mid-session.
    setSkipCaptures(!!agentState.user?.screenshotExempt);
  }

  // Notify the user when screen capture itself fails (upload failures are queued offline)
  setCaptureFailedCallback(() => {
    if (Notification.isSupported()) {
      new Notification({
        title: 'Screenshot capture failed',
        body: 'TimeProof could not capture your screen. Please check your screen recording permissions. Your admin may see a gap in your activity.',
        silent: false,
      }).show();
    }
  });

  // Guard screenshots against break state — even if the tray misses a break-in
  // socket event and stopScreenshots() is never called, the capture loop itself
  // will skip every interval tick while the agent is on break.
  setOnBreakGetter(() => agentState.isOnBreak);

  // Proactively renew token every 10 hours (CRM mode only — main JWT is refreshed by the browser)
  tokenRefreshIntervalId = authMode === 'crm' ? setInterval(async () => {
    const current = store.get('crm_token') as string | undefined;
    if (!current) return;
    const refreshed = await tryRefreshToken(current);
    if (!refreshed) {
      handleLogout();
      return;
    }
    // Propagate the renewed JWT everywhere it's used — previously only the
    // store got the new token, so heartbeat and the socket kept using the
    // old one until it eventually expired, silently breaking real-time sync
    // and (once the old token expired outright) heartbeats too.
    updateHeartbeatToken(refreshed);
    updateSocketToken(refreshed);
  }, TOKEN_REFRESH_INTERVAL_MS) : null;

  startIdleMonitor(async (isIdle) => {
    const wasIdle = agentState.isIdle;
    agentState.isIdle = isIdle;

    // Activity tracking only applies while the user is clocked in and not on break
    const wasTracking = agentState.isOnShift && !agentState.isOnBreak;

    if (isIdle && !wasIdle) {
      // User just went idle — save the completed active interval if we were counting.
      // Truncate endAt to when the user last had input rather than using Date.now(),
      // which would include sleep time if the computer just woke from suspension.
      if (wasTracking && activityStartMs !== null) {
        const idleSec = powerMonitor.getSystemIdleTime();
        const endAt = new Date(Date.now() - idleSec * 1000);
        await commitActiveSegment(endAt);
        activityStartMs = null;
        agentState.activityStartMs = null;
      }
      stopScreenshots();
      agentState.nextScreenshotIn = null;

      // Immediately tell the server the interval has stopped (currentIntervalStartAt=null)
      // so the CRM timer freezes in lock-step instead of lagging until the next 60s heartbeat.
      if (wasTracking) pingHeartbeat();

      if (wasTracking && Notification.isSupported()) {
        new Notification({
          title: 'You are idle',
          body: 'You have been inactive for 10+ minutes. Timer and screenshots paused.',
          silent: false,
        }).show();
      }
    } else if (!isIdle && wasIdle) {
      // User became active — resume only if clocked in and not on break
      if (wasTracking) {
        activityStartMs = Date.now();
        agentState.activityStartMs = activityStartMs;
        const currentToken = store.get('crm_token') as string | undefined;
        if (currentToken && agentState.isAuthenticated) {
          startScreenshots(API_URL, currentToken);
          const nextIn = Date.now() + SCREENSHOT_INTERVAL_MS;
          agentState.nextScreenshotIn = new Date(nextIn).toISOString();
        }
        pingHeartbeat();
      }
    }

    broadcastState();
  });

  // Periodic checkpoint: while actively tracking, commit the segment so far
  // and roll the start point forward every 10 minutes. Without this, a long
  // continuous active stretch (no idle gaps) is only ever committed when it
  // ENDS — an unexpected tray restart mid-stretch (crash, auto-update
  // relaunch, killed on sleep) loses everything since the last idle
  // transition instead of just the last few minutes.
  activityCheckpointIntervalId = setInterval(async () => {
    if (!agentState.isOnShift || agentState.isOnBreak || agentState.isIdle || activityStartMs === null) return;
    const now = new Date();
    const committed = await commitActiveSegment(now);
    // Only roll the start point forward if the commit actually succeeded —
    // otherwise this chunk is silently dropped (activityStartMs would move to
    // "now" while todayTotalActiveMs never received the duration), and every
    // subsequent checkpoint keeps re-losing time the same way. Leaving
    // activityStartMs untouched means the next tick retries the FULL
    // accumulated duration instead.
    if (committed) {
      activityStartMs = now.getTime();
      agentState.activityStartMs = activityStartMs;
    }
  }, ACTIVITY_CHECKPOINT_MS);

  // Check every 30s if break has run 4 minutes past the 1h limit — warn the
  // user once per break session, a minute before the backend escalates to
  // their admin/manager at the 5-minute mark (see BREAK_ADMIN_NOTIFY_SECONDS
  // in crmTimeproof.controller.ts) — a short heads-up to wrap up before
  // their admin gets involved, not a "your admin already knows" message.
  const BREAK_WARNING_SECONDS = 60 * 60 + 4 * 60;
  breakExceededNotified = false;
  breakNotifyIntervalId = setInterval(() => {
    if (!agentState.isOnBreak || !agentState.breakStartedAt) {
      breakExceededNotified = false;
      return;
    }
    if (breakExceededNotified) return;
    const breakSecs = Math.floor((Date.now() - new Date(agentState.breakStartedAt).getTime()) / 1000);
    if (breakSecs >= BREAK_WARNING_SECONDS && Notification.isSupported()) {
      breakExceededNotified = true;
      new Notification({
        title: 'Break time exceeded',
        body: "You've gone over your 1-hour break. Please wrap up soon — your admin will be notified shortly if it continues.",
        silent: false,
      }).show();
    }
  }, 30_000);

  // Auto clock-out: once a shift has already rendered 8+ hours, 30 continuous
  // minutes of no keyboard/mouse input is treated as "done and forgot to end
  // shift" rather than a normal break. Checked every 60s against the OS's own
  // idle-time counter (not our 30s poll cadence) so it fires close to the
  // 30-minute mark regardless of when the last check happened to run.
  autoClockoutTriggeredForThisIdleStretch = false;
  autoClockoutCheckIntervalId = setInterval(async () => {
    if (!agentState.isOnShift || agentState.isOnBreak) { autoClockoutTriggeredForThisIdleStretch = false; return; }
    const idleMs = powerMonitor.getSystemIdleTime() * 1000;
    if (idleMs < AUTO_CLOCKOUT_IDLE_MS) { autoClockoutTriggeredForThisIdleStretch = false; return; }
    if (autoClockoutTriggeredForThisIdleStretch) return;
    if (getRenderedMsSoFar() < AUTO_CLOCKOUT_RENDERED_HOURS_MS) return; // hasn't earned the 8h yet — leave shift open

    autoClockoutTriggeredForThisIdleStretch = true;
    const result = await performClockAction('time-out', 'Auto clock-out — 30+ minutes without activity after rendering 8+ hours');
    if (result.success && Notification.isSupported()) {
      new Notification({
        title: 'Shift ended automatically',
        body: 'You were inactive for 30+ minutes after completing 8 hours — your shift was clocked out. Click Resume if you\'re still working.',
        silent: false,
      }).show();
    }
  }, 60_000);

  startHeartbeat(API_URL, token, () => {
    const isOnBreak = agentState.isOnBreak;
    const isOnShift = agentState.isOnShift;
    const breakDurationSeconds = isOnBreak && agentState.breakStartedAt
      ? Math.floor((Date.now() - new Date(agentState.breakStartedAt).getTime()) / 1000)
      : 0;
    // Report activityStartMs (this machine's clock). The CRM browser runs on the
    // same machine, so it computes (Date.now() - activityStartMs) in the SAME clock
    // domain → both timers match exactly. Reporting a server timestamp here would
    // mix the machine clock (CRM's Date.now()) with the server clock and surface
    // any clock skew as visible drift between the two displays.
    const currentIntervalStartAt = activityStartMs ? new Date(activityStartMs).toISOString() : null;
    return { isOnBreak, breakDurationSeconds, isOnShift, currentIntervalStartAt };
  });

  connectSocket(
    API_URL,
    token,
    (partial) => {
      const prevIsOnBreak = agentState.isOnBreak;
      const prevIsOnShift = agentState.isOnShift;
      // "was counting" = clocked in and not on break, not idle, AND the interval timer was running.
      // Including activityStartMs !== null prevents "Shift Open — Tap Resume" state (isOnShift=true,
      // isOnBreak=false, activityStartMs=null) from being treated as wasTracking=true, which would
      // cause break-out events to be a no-op (both wasTracking and isNowTracking stay true → no transition fires).
      const wasTracking = prevIsOnShift && !prevIsOnBreak && !agentState.isIdle && activityStartMs !== null;
      // Detect a break-out event specifically so we can force-resume when the tray was in
      // "Tap Resume" state (activityStartMs=null, isOnBreak already false locally) and thus
      // prevIsOnBreak=false — meaning justEndedBreak would be false, but we still need to resume.
      const isBreakOutEvent = 'isOnBreak' in partial && (partial as { isOnBreak: boolean }).isOnBreak === false && !('isOnShift' in partial);

      agentState = { ...agentState, ...partial };
      agentState.isAgentOnline = true;

      // Toggle the wall-clock ticking flag immediately on transitions instead
      // of waiting for the next 60s syncShiftState poll — wallClockBaseMs
      // itself (the accumulated figure) still only refreshes on that poll,
      // so a resumed session may briefly over/undercount until the next one,
      // same self-correcting tolerance as the rest of this mechanism.
      wallClockBaseAt = (agentState.isOnShift && !agentState.isOnBreak) ? Date.now() : null;
      agentState.wallClockBaseAt = wallClockBaseAt;

      // Capture whether shift/break state changed BEFORE tracking transitions so we
      // can call pingHeartbeat() AFTER activityStartMs is correctly set/cleared.
      const shiftStateChanged = agentState.isOnBreak !== prevIsOnBreak || agentState.isOnShift !== prevIsOnShift;

      if (prevIsOnBreak && !agentState.isOnBreak) {
        breakExceededNotified = false;
      }

      const isNowTracking = agentState.isOnShift && !agentState.isOnBreak && !agentState.isIdle;

      if (wasTracking && !isNowTracking) {
        // Clocked out or went on break — save the current active interval (fire-and-forget)
        if (activityStartMs !== null) {
          const endAt = new Date();
          const durationMs = endAt.getTime() - activityStartMs;
          const currentToken = store.get('crm_token') as string | undefined;
          if (currentToken && durationMs >= 30_000) {
            axios.post(
              `${API_URL}${getActivityIntervalUrl()}`,
              { startAt: new Date(activityStartMs).toISOString(), endAt: endAt.toISOString() },
              { headers: { Authorization: `Bearer ${currentToken}` }, timeout: 10_000 }
            ).then(() => {
              todayTotalActiveMs += durationMs;
              agentState.todayTotalActiveMs = todayTotalActiveMs;
              broadcastState();
            }).catch(() => {});
          }
          activityStartMs = null;
          agentState.activityStartMs = null;
        }
        stopScreenshots();
        agentState.nextScreenshotIn = null;
      } else if (!wasTracking && isNowTracking) {
        // Transition from not-tracking → tracking. Two legitimate paths:
        //  (a) User just ended a break elsewhere (wasOnBreak transitioning false) —
        //      they're actively back at work, resume tracking regardless of shift age.
        //  (b) Shift was just started (< 5 min ago) — fresh handoff from CRM clock-in.
        //
        // We DON'T auto-resume for stale opens (e.g. socket reconnect surfacing an
        // older unclosed shift) — that's what the "Shift Open — Tap Resume" state is for.
        const SHIFT_AUTO_RESUME_MS = 5 * 60 * 1000;
        const shiftStartedAtMs = agentState.shiftStartedAt
          ? new Date(agentState.shiftStartedAt).getTime() : 0;
        const shiftStartedRecently = shiftStartedAtMs > 0
          && (Date.now() - shiftStartedAtMs) < SHIFT_AUTO_RESUME_MS;
        const justEndedBreak = prevIsOnBreak && !agentState.isOnBreak;

        if (justEndedBreak || shiftStartedRecently || (isBreakOutEvent && activityStartMs === null)) {
          activityStartMs = Date.now();
          agentState.activityStartMs = activityStartMs;
          const nextIn = Date.now() + SCREENSHOT_INTERVAL_MS;
          agentState.nextScreenshotIn = new Date(nextIn).toISOString();
          startScreenshots(API_URL, token);
        }
      }

      // Ping AFTER activityStartMs is set/cleared so the DB gets the correct
      // currentIntervalStartAt — calling it before would send null on clock-in.
      if (shiftStateChanged) {
        pingHeartbeat();
      }

      broadcastState();
      flushQueue(API_URL, token).catch(() => {});
    },
    () => { syncShiftState(token); },
    () => {
      if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
    },
  );

  // Sync state. syncShiftState already handles auto-resume tracking (gated to
  // shifts started within the last 5 minutes) — DO NOT add an unconditional
  // auto-start here. An older open shift (e.g. forgotten clock-out from earlier
  // today) shows up as "Shift Open — Tap Resume" in the tray UI; the user
  // explicitly clicks Resume to opt back into tracking.
  await syncShiftState(token);
  if (activityStartMs !== null) {
    // syncShiftState set activityStartMs (recent shift) — propagate to the server
    pingHeartbeat();
  }

  // Re-sync every 60 seconds (same cadence as heartbeat) so missed socket
  // events (break-in, break-out, time-out) self-correct within one minute
  // rather than waiting the old 5-minute window.
  resyncIntervalId = setInterval(() => {
    const currentToken = store.get('crm_token') as string | undefined;
    if (currentToken) syncShiftState(currentToken);
  }, 60 * 1000);

  // Poll for active call state every 10s — drives recording/Autrix menu visibility
  startCallStatePolling(
    API_URL,
    () => store.get('crm_token') as string | undefined,
    (_call) => { tray?.setContextMenu(buildTrayMenu()); broadcastState(); },
  );

  // Real-time socket — receives tray:start-recording / tray:stop-recording from backend
  connectTraySocket(token);
};

const stopAgentServices = () => {
  if (tokenRefreshIntervalId) {
    clearInterval(tokenRefreshIntervalId);
    tokenRefreshIntervalId = null;
  }
  if (breakNotifyIntervalId) {
    clearInterval(breakNotifyIntervalId);
    breakNotifyIntervalId = null;
  }
  if (resyncIntervalId) {
    clearInterval(resyncIntervalId);
    resyncIntervalId = null;
  }
  if (autoClockoutCheckIntervalId) {
    clearInterval(autoClockoutCheckIntervalId);
    autoClockoutCheckIntervalId = null;
  }
  if (activityCheckpointIntervalId) {
    clearInterval(activityCheckpointIntervalId);
    activityCheckpointIntervalId = null;
  }
  breakExceededNotified = false;
  autoClockoutTriggeredForThisIdleStretch = false;
  stopIdleMonitor();
  stopHeartbeat();
  stopScreenshots();
  disconnectSocket();
  stopCallStatePolling();
  disconnectTraySocket();
  destroyRecorderWindow();
  if (autrixWindow && !autrixWindow.isDestroyed()) {
    autrixWindow.close();
    autrixWindow = null;
  }
};

/* ─────────────────────────────────────────────────────────────────
   Auth handlers
   Sign-in happens on the dashboard in the browser — it silently hands a
   token to startLocalAuthServer() / handleTrayAuth() below. There is no
   manual login form in this app anymore.
───────────────────────────────────────────────────────────────── */
const handleLogout = async () => {
  stopAgentServices();
  activityStartMs = null;
  todayTotalActiveMs = 0;
  wallClockBaseMs = 0;
  wallClockBaseAt = null;
  store.delete('crm_token');
  store.delete('auth_mode');
  store.delete('user');
  agentState = {
    isAuthenticated: false,
    user: null,
    isOnShift: false,
    isOnBreak: false,
    isIdle: false,
    isAgentOnline: false,
    shiftStartedAt: null,
    breakStartedAt: null,
    nextScreenshotIn: null,
    totalBreakSeconds: 0,
    todayTotalWorkedSeconds: 0,
    activityStartMs: null,
    todayTotalActiveMs: 0,
    wallClockBaseMs: 0,
    wallClockBaseAt: null,
  };
  updateTrayIcon();
  tray?.setContextMenu(buildTrayMenu());
  broadcastState();
  showStatusWindow();
};

/* ─────────────────────────────────────────────────────────────────
   IPC handlers
───────────────────────────────────────────────────────────────── */
ipcMain.handle('auth:logout', handleLogout);

ipcMain.handle('status:get', () => agentState);

ipcMain.handle('app:open-crm', () => shell.openExternal(CRM_URL));
ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.handle('shift:check-resumable', async () => {
  const token = store.get('crm_token') as string | undefined;
  if (!token) return { resumable: false };
  try {
    const { data } = await axios.get(`${API_URL}${getResumableShiftUrl()}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10_000,
    });
    return data?.data ?? { resumable: false };
  } catch {
    return { resumable: false };
  }
});

const performClockAction = async (type: string, note?: string): Promise<{ success: boolean; error?: string }> => {
  const token = store.get('crm_token') as string | undefined;
  if (!token) return { success: false, error: 'Not authenticated' };
  try {
    // Capture a screenshot before ending shift (CRM mode only — main mode skips screenshots)
    if (type === 'time-out' && getAuthMode() === 'crm') {
      captureAndUploadOnce(API_URL, token).catch(() => {});
    }
    await axios.post(`${API_URL}${getClockUrl()}`, { type, ...(note && { note }) }, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15_000,
    });
    // Sync in background, then ensure tracking state is correct.
    // The socket event and syncShiftState can race — if syncShiftState wins and
    // updates isOnShift before the socket event fires, the socket handler sees
    // wasTracking === isNowTracking and skips the tracking-start branch.
    // This .then() handles that case by starting tracking if still unset.
    syncShiftState(token).then(() => {
      if (agentState.isOnShift && !agentState.isOnBreak && !agentState.isIdle && activityStartMs === null) {
        activityStartMs = Date.now();
        agentState.activityStartMs = activityStartMs;
        startScreenshots(API_URL, token);
        pingHeartbeat();
        broadcastState();
      }
    }).catch(() => {});
    return { success: true };
  } catch (err: any) {
    let msg = err?.response?.data?.message || 'Action failed';

    // There is no manual login form in the tray anymore — "log in again" is
    // stale guidance. The actual recovery path is: the website hands the tray
    // a fresh token via the "Tray App Required" reconnect flow, so point the
    // user there instead of telling them to do something that no longer exists.
    if (/session expired/i.test(msg)) {
      msg = 'Session expired. Click "Open CRM" below, then try Start Shift again on the website to reconnect.';
    }

    // Resume path: backend already has an open clock-in (carried over from a
    // forgotten or older session). The tray no longer auto-tracks on launch for
    // older shifts, so the user has to click Start Shift again to opt in. Treat
    // that click as "resume tracking on the existing shift" rather than an error.
    if (type === 'time-in' && /already clocked in/i.test(msg)) {
      // Backend confirmed user IS on shift — assert isOnShift immediately so
      // the UI shows at least "Shift Open — Tap Resume" even if syncShiftState
      // fails silently (network error, server down, etc.).
      agentState.isOnShift = true;
      await syncShiftState(token); // never throws; updates agentState on success
      if (agentState.isOnShift && !agentState.isOnBreak && !agentState.isIdle && activityStartMs === null) {
        activityStartMs = Date.now();
        agentState.activityStartMs = activityStartMs;
        startScreenshots(API_URL, token);
        pingHeartbeat();
      }
      broadcastState(); // always broadcast so UI reflects correct shift state
      return { success: true };
    }
    return { success: false, error: msg };
  }
};

ipcMain.handle('timeclock:action', async (_e, type: string, note?: string) => performClockAction(type, note));

/* ─────────────────────────────────────────────────────────────────
   Autrix AI IPC handlers
───────────────────────────────────────────────────────────────── */
ipcMain.handle('autrix:get-token', () => store.get('crm_token') as string | undefined ?? '');
ipcMain.handle('autrix:get-api-url', () => API_URL);
ipcMain.handle('autrix:get-transcript', () => getFullTranscript());
ipcMain.handle('autrix:get-call-info', () => {
  const call = getCurrentCall();
  if (!call) return null;
  return {
    title: call.title ?? 'Meeting',
    meetingId: call.meetingId,
    isRecording: getRecordingStatus() === 'recording',
  };
});
ipcMain.handle('autrix:close', () => {
  autrixWindow?.hide();
});
ipcMain.handle('autrix:open', () => showAutrixWindow());

ipcMain.handle('recording:start-request', () => {
  const call = getCurrentCall();
  if (call && call.canRecord) handleStartRecording(call);
});
ipcMain.handle('recording:stop-request', () => handleStopRecording());

/* ─────────────────────────────────────────────────────────────────
   Auth via token — shared by protocol URL and local HTTP server
───────────────────────────────────────────────────────────────── */
const handleTrayAuth = async (token: string): Promise<boolean> => {
  if (!token) return false;
  // Same token already active — nothing to do
  if (agentState.isAuthenticated && store.get('crm_token') === token) return true;

  const wasAuthenticated = agentState.isAuthenticated;
  let user: User | null = null;
  let authMode: 'crm' | 'main' = 'crm';

  // Try CRM auth first
  try {
    const { data } = await axios.get(`${API_URL}/api/crm/me`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10_000,
    });
    const d: User = data?.data || data;
    if (d?.fullName) { user = d; authMode = 'crm'; }
  } catch {
    // CRM auth failed — fall through to main system auth
  }

  // Fallback: try main system (Clerk JWT) endpoint
  if (!user) {
    try {
      const { data } = await axios.get(`${API_URL}/api/timeclock/me`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10_000,
      });
      const d = data?.data || data;
      if (d?.fullName) {
        user = { fullName: d.fullName, username: d.email || d.username || '', role: d.role || 'employee' };
        authMode = 'main';
      }
    } catch {
      return false;
    }
  }

  if (!user?.fullName) return false;

  agentState.isAuthenticated = true;
  agentState.user = user;
  agentState.isAgentOnline = true;
  store.set('crm_token', token);
  store.set('auth_mode', authMode);
  store.set('user', user);
  updateHeartbeatToken(token); // keep heartbeat JWT in sync when page sends a refreshed token
  // startAgentServices (and its connectSocket call) only runs on the FIRST
  // auth — a refreshed token arriving while already authenticated used to
  // never reach the socket, leaving it running on the original (eventually
  // stale) token until the app restarted.
  if (wasAuthenticated) updateSocketToken(token);
  else startAgentServices(token);
  broadcastState();
  return true;
};

/* ─────────────────────────────────────────────────────────────────
   Local HTTP auth server — CRM web POSTs to this silently,
   zero browser dialog, tray auto-logs in when already running.
   Port 18642 — localhost only, no firewall exposure.
───────────────────────────────────────────────────────────────── */
const TRAY_AUTH_PORT = 18642;

const startLocalAuthServer = () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Chrome Private Network Access: grants the silent preflight so the
    // CRM web page (public HTTPS origin) can push the auth token to this
    // loopback server without a permission prompt or hard block.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST' || req.url !== '/auth') { res.writeHead(404); res.end(); return; }

    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const { token } = JSON.parse(body) as { token: string };
        const ok = await handleTrayAuth(token);
        res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    });
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') console.error('[tray-auth]', err.message);
  });

  server.listen(TRAY_AUTH_PORT, '127.0.0.1', () => {
    console.log(`[tray-auth] Listening on 127.0.0.1:${TRAY_AUTH_PORT}`);
  });
};

/* ─────────────────────────────────────────────────────────────────
   Protocol handler — actionauto://auth?token=JWT
   Fallback for when tray was not running at login time
───────────────────────────────────────────────────────────────── */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

if (process.defaultApp) {
  if (process.argv.length >= 2) app.setAsDefaultProtocolClient('actionauto', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('actionauto');
}

const handleProtocolUrl = async (url: string) => {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'auth') return;
    const token = parsed.searchParams.get('token');
    if (token) await handleTrayAuth(token);
  } catch {
    // Silent fail — user can still log in manually
  }
};

// Windows: protocol URL comes via second-instance argv
app.on('second-instance', (_event, argv) => {
  const url = argv.find(a => a.startsWith('actionauto://'));
  if (url) handleProtocolUrl(url);
});

// macOS: comes via open-url event
app.on('open-url', (_event, url) => handleProtocolUrl(url));

/* ─────────────────────────────────────────────────────────────────
   App ready
───────────────────────────────────────────────────────────────── */
app.whenReady().then(async () => {
  // Tray-only app — no dock icon on macOS
  if (process.platform === 'darwin') app.dock?.hide();
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  try { autoLauncher.enable(); } catch { } // register with auto-launch as fallback
  registerRecordingIpcHandlers();
  startLocalAuthServer();

  // Auto clock-out on sleep/shutdown — only once the shift has already
  // rendered 8+ hours (same rule as the idle-based trigger above). Electron
  // gives no guaranteed grace period before the OS actually suspends/powers
  // off, so this is best-effort: if it doesn't land in time (abrupt power
  // loss, OS doesn't wait), the backend's own stale-shift safety net closes
  // the shift later using the last known activity instead.
  //
  // Below 8h rendered, we don't end the shift, but we DO flush a checkpoint
  // of whatever's been tracked so far — otherwise the in-memory-only active
  // segment rides through the sleep/shutdown unsaved, and if the process
  // doesn't survive to resume normally, that time is gone for good.
  const handleSystemSuspendOrShutdown = (reason: string) => {
    if (!agentState.isOnShift || agentState.isOnBreak) return;
    if (getRenderedMsSoFar() >= AUTO_CLOCKOUT_RENDERED_HOURS_MS) {
      performClockAction('time-out', `Auto clock-out — device ${reason} after rendering 8+ hours`).catch(() => {});
      return;
    }
    if (activityStartMs !== null) {
      const checkpointAt = new Date();
      // commitActiveSegment never rejects (it swallows its own POST errors),
      // so .then() alone can't distinguish success from failure — check the
      // resolved boolean, same reasoning as the periodic checkpoint above.
      commitActiveSegment(checkpointAt).then((committed) => {
        if (committed) {
          activityStartMs = checkpointAt.getTime();
          agentState.activityStartMs = activityStartMs;
        }
      });
    }
  };
  powerMonitor.on('suspend', () => handleSystemSuspendOrShutdown('went to sleep'));
  powerMonitor.on('shutdown', () => handleSystemSuspendOrShutdown('shut down'));

  tray = new Tray(getTrayIcon());
  tray.setToolTip('Action Auto Tray');
  tray.setContextMenu(buildTrayMenu());

  tray.on('click', () => {
    if (statusWindow?.isVisible()) statusWindow.hide();
    else showStatusWindow();
  });

  createStatusWindow();

  const savedToken = store.get('crm_token') as string | undefined;
  const savedUser = store.get('user');
  if (savedToken && savedUser) {
    agentState.isAuthenticated = true;
    agentState.user = savedUser as User;
    agentState.isAgentOnline = true;
    updateTrayIcon();
    tray.setContextMenu(buildTrayMenu());
    // Proactively refresh token on startup (CRM mode only — main JWT is refreshed by the browser)
    const activeToken = getAuthMode() === 'crm' ? (await tryRefreshToken(savedToken) ?? savedToken) : savedToken;
    startAgentServices(activeToken);
  } else {
    // No saved session — sign-in happens on the dashboard in the browser, which
    // silently hands a token to startLocalAuthServer() above. Show the waiting
    // panel so the user knows what's happening instead of a login form.
    showStatusWindow();
  }

  // Check for updates 15s after startup so the app is fully initialized first,
  // then keep re-checking periodically — this app can stay running for days,
  // so a single launch-time check isn't enough to catch a new release promptly.
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, 15_000);
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, UPDATE_CHECK_INTERVAL_MS);
  }
});

// Keep app running in tray even when all windows are closed
app.on('window-all-closed', () => { /* intentional noop */ });
