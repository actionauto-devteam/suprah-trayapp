import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, screen, Notification, powerMonitor, dialog, safeStorage } from 'electron';

app.setName('Suprah AI - Timeproof Clock');
app.setPath('userData', app.getPath('userData'));
app.disableHardwareAcceleration();
import path from 'path';
import os from 'os';
import http from 'http';
import axios from 'axios';
import dotenv from 'dotenv';

const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '..', '.env');
dotenv.config({ path: envPath });
import { connectSocket, disconnectSocket, updateSocketToken } from './socket';
import { startIdleMonitor, stopIdleMonitor, setIdleDetectionExempt, getIdleSecondsHistory, forceIdleState, IDLE_THRESHOLD_SEC, getLastIdleSeconds, isLastIdleSampleReliable } from './idle';
import { startHeartbeat, stopHeartbeat, pingHeartbeat, setHeartbeatPath, updateHeartbeatToken, setOnScreenshotsRequired, setOnAuthRejected } from './heartbeat';
import { startScreenshots, stopScreenshots, isScreenshotRunning, captureAndUploadOnce, setCaptureFailedCallback, setCaptureSucceededCallback, setOnBreakGetter, setSkipCaptures, setMainMonitorOnly, reportDiagnostic, updateScreenshotToken, toShiftDate } from './screenshot';
import { flushQueue } from './offline-queue';
import { getScreenRecordingGranted, openScreenRecordingSettings } from './permissions';
import { startIdleRecording, stopAndUploadIdleRecording, destroyIdleRecorderWindow, registerIdleRecordingIpcHandlers, getIdleRecordingStatus } from './idleRecording';
import { flushIdleRecordingQueue } from './idleRecordingQueue';
import { SESSION_CHECK_INTERVAL_MS, TOKEN_REFRESH_WINDOW_MS, isAuthRejection, isStaleSameUserToken, probeToken, readTokenClaims, refreshToken, shouldRefreshNow } from './session';
import { isNewerVersion } from './version';
import { buildAllowedOrigins, matchOrigin } from './originPolicy';
import { createAuthCoordinator } from './authCoordinator';
import type { ConfirmPrompt, ConnectionState, InfoPrompt } from './authCoordinator';
import {
  clearDeviceCredential,
  deviceCredentialExists,
  isAutoSignInPaused,
  loadDeviceCredential,
  saveDeviceCredential,
  setAutoSignInPaused,
} from './deviceStorage';
import { fetchLatestVersion, getInstallerUrl } from './updateCheck';
import { startDesktopLocation, stopDesktopLocation, pauseDesktopLocation, resumeDesktopLocation } from './desktopLocation';

const AutoLaunch = require('auto-launch') as new (opts: { name: string; isHidden: boolean }) => { disable: () => Promise<unknown> };

type StoreInstance = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
};
const Store = require('electron-store').default;
const store = new Store({ encryptionKey: 'aa-tray-secure-key', clearInvalidConfig: true }) as StoreInstance;

/* ─────────────────────────────────────────────────────────────────
   Auth-mode helpers — 'crm' uses /api/crm/* endpoints,
   'main' uses /api/timeclock/* endpoints (Clerk/main-system JWT)
───────────────────────────────────────────────────────────────── */
const getAuthMode = (): 'crm' | 'main' => (store.get('auth_mode') as 'crm' | 'main') || 'crm';
const getShiftStateUrl  = () => getAuthMode() === 'main' ? '/api/timeclock/shift-state'      : '/api/crm/timeproof/shift-state';
const getActivityIntervalUrl = () => getAuthMode() === 'main' ? '/api/timeclock/activity-interval' : '/api/crm/timeproof/activity-interval';
const getResumableShiftUrl   = () => getAuthMode() === 'main' ? '/api/timeclock/resumable-shift'   : '/api/crm/timeproof/resumable-shift';
const getResumeShiftActionUrl = () => getAuthMode() === 'main' ? '/api/timeclock/resume-shift'      : '/api/crm/timeproof/resume-shift';
const getClockUrl            = () => getAuthMode() === 'main' ? '/api/timeclock/clock'             : '/api/crm/time-clock';

/* ─────────────────────────────────────────────────────────────────
   Crash resilience
───────────────────────────────────────────────────────────────── */
const CRASH_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;
let lastCrashNotifiedAt = 0;

const notifyCrashOnce = (title: string, body: string): void => {
  const now = Date.now();
  if (now - lastCrashNotifiedAt < CRASH_NOTIFY_COOLDOWN_MS) return;
  lastCrashNotifiedAt = now;
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: true }).show();
  }
};

process.on('uncaughtException', (err) => {
  reportDiagnostic('main_uncaught_exception', err?.message || String(err), {
    stack: err instanceof Error ? err.stack : undefined,
    platform: process.platform,
  });
  notifyCrashOnce('TimeProof hit an error', 'The app recovered and is still tracking. If problems continue, please restart it.');
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  reportDiagnostic('main_unhandled_rejection', err.message, {
    stack: err.stack,
    platform: process.platform,
  });
});

const safeAsync = (fn: () => Promise<void>, label: string) => async () => {
  try {
    await fn();
  } catch (err) {
    reportDiagnostic('interval_error', `${label} threw`, {
      error: err instanceof Error ? err.message : String(err),
      platform: process.platform,
    });
  }
};

/* ─────────────────────────────────────────────────────────────────
   Config
───────────────────────────────────────────────────────────────── */
const CRM_URL = process.env.CRM_URL || 'https://your-crm-url.com/crm';
const API_URL = process.env.API_URL || 'https://your-api-url.com';

const autoLauncher = new AutoLaunch({ name: 'Suprah AI - Timeproof Clock', isHidden: true });

/* ─────────────────────────────────────────────────────────────────
   State
───────────────────────────────────────────────────────────────── */
interface User {
  fullName: string;
  username: string;
  role: string;
  screenshotExempt?: boolean;
  screenshotsRequired?: boolean;
  mainMonitorOnly?: boolean;
  idleDetectionExempt?: boolean;
  idleVideoProofEnabled?: boolean;
  desktopLocationEnabled?: boolean;
  trayDeviceAuthEnabled?: boolean;
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
  screenshotsToday: number;
  totalBreakSeconds: number;
  todayTotalWorkedSeconds: number;
  // Activity-based tracking (idle-aware timer)
  activityStartMs: number | null;
  todayTotalActiveMs: number;
  // Authoritative rendered-hours baseline from TimeLog (CRM Today card), ticks from wallClockBaseAt, avoids activityStartMs reset bug.
  wallClockBaseMs: number;
  wallClockBaseAt: number | null;
  // macOS-only flag; null elsewhere or before first check, not guaranteed stable once granted (unsigned build).
  screenRecordingGranted: boolean | null;
  idleRecordingActive: boolean;
  sessionExpired: boolean;
  updateAvailable: { version: string } | null;
  connection: { state: ConnectionState; message: string } | null;
}

let tray: Tray | null = null;
let statusWindow: BrowserWindow | null = null;

let breakNotifyIntervalId: ReturnType<typeof setInterval> | null = null;
let screenRecordingCheckIntervalId: ReturnType<typeof setInterval> | null = null;
let lastNotifiedScreenRecordingMissing = false;
let resyncIntervalId: ReturnType<typeof setInterval> | null = null;
let departmentFlagsRefreshIntervalId: ReturnType<typeof setInterval> | null = null;
let autoClockoutCheckIntervalId: ReturnType<typeof setInterval> | null = null;
let breakExceededNotified = false;
let autoClockoutTriggeredForThisIdleStretch = false;

// Minimum rendered hours before auto-clock-out triggers (idle timeout or sleep/shutdown) can apply.
const AUTO_CLOCKOUT_RENDERED_HOURS_MS = 8 * 60 * 60 * 1000;
// Last-resort fallback only — the primary 30-minute auto-end now lives on the
// backend (staged idle escalation, see idle.ts's stage2/stage3 thresholds +
// postHeartbeat), which is clamp-protected and evidence-attached. This raw,
// unprotected local check only fires if the backend genuinely couldn't be
// reached (no live 'time-out' socket push arrived before this later mark) —
// bumped 5 minutes past the backend's own 30-minute mark so it never races
// the normal case, and its note is deliberately distinguishable so a fallback
// firing is diagnosable rather than silently indistinguishable from the
// primary path.
const AUTO_CLOCKOUT_IDLE_MS = 35 * 60 * 1000;

/**
 * Rendered active ms for current shift (breaks excluded), from authoritative
 * wall‑clock baseline (CRM Today card), not activityStartMs/todayTotalActiveMs,
 * so auto‑clockout decisions hit the 8h threshold correctly without under‑reporting.
 */
const getRenderedMsSoFar = (): number =>
  wallClockBaseMs + (wallClockBaseAt !== null ? Date.now() - wallClockBaseAt : 0);

// Activity-based time tracking (idle-aware) — still used for ActivityInterval
// commits (idle log / monitoring) and screenshot gating, just no longer as
// the basis for the displayed timer or auto-clockout hour-threshold checks.
let activityStartMs: number | null = null;  // when current active period began (local clock)
let todayTotalActiveMs: number = 0;         // sum of completed active interval durations
// Constant onset of the whole idle stretch, shared across all 3 video chunks
// (1: 0-10min, 2: 10-20min, 3: 20-30min) so they group under the same backend
// storage key — set once when chunk 1 starts, untouched by later chunk starts.
let idleStretchStartMs: number | null = null;
let currentIdleChunkIndex: 1 | 2 | 3 | null = null;

// Authoritative wall-clock baseline — see AgentState.wallClockBaseMs/wallClockBaseAt.
let wallClockBaseMs: number = 0;
let wallClockBaseAt: number | null = null;

const createAgentState = (): AgentState => ({
  isAuthenticated: false,
  user: null,
  isOnShift: false,
  isOnBreak: false,
  isIdle: false,
  isAgentOnline: false,
  shiftStartedAt: null,
  breakStartedAt: null,
  nextScreenshotIn: null,
  screenshotsToday: 0,
  totalBreakSeconds: 0,
  todayTotalWorkedSeconds: 0,
  activityStartMs: null,
  todayTotalActiveMs: 0,
  wallClockBaseMs: 0,
  wallClockBaseAt: null,
  screenRecordingGranted: null,
  idleRecordingActive: false,
  sessionExpired: false,
  updateAvailable: null,
  connection: null,
});

let agentState: AgentState = createAgentState();

/* ─────────────────────────────────────────────────────────────────
   State broadcast helpers
───────────────────────────────────────────────────────────────── */
const STATUS_HEIGHT_BASE = 460;
const SCREEN_RECORDING_BANNER_HEIGHT = 60;
const UPDATE_BANNER_HEIGHT = 100;

let lastTraySignature = '';

const getStatusWindowTargetHeight = (): number =>
  STATUS_HEIGHT_BASE
  + (agentState.screenRecordingGranted === false ? SCREEN_RECORDING_BANNER_HEIGHT : 0)
  + (agentState.updateAvailable ? UPDATE_BANNER_HEIGHT : 0);

const fitStatusWindow = (): void => {
  if (!statusWindow || statusWindow.isDestroyed()) return;
  const targetH = getStatusWindowTargetHeight();
  const [currentW, currentH] = statusWindow.getSize();
  if (currentH === targetH) return;
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
  statusWindow.setSize(currentW, targetH);
  statusWindow.setPosition(screenW - currentW - 16, screenH - targetH - 16);
};

const broadcastState = () => {
  if (statusWindow && !statusWindow.isDestroyed()) {
    fitStatusWindow();
    statusWindow.webContents.send('status:update', agentState);
  }
  const traySignature = [
    agentState.isAuthenticated,
    agentState.isAgentOnline,
    agentState.user?.fullName ?? '',
    agentState.isOnShift,
    activityStartMs !== null,
    agentState.isIdle,
    agentState.isOnBreak,
    agentState.sessionExpired,
    agentState.updateAvailable?.version ?? '',
    agentState.connection?.state ?? '',
  ].join('|');
  if (traySignature !== lastTraySignature) {
    lastTraySignature = traySignature;
    updateTrayIcon();
    tray?.setContextMenu(buildTrayMenu());
  }
};

// Hoisted to module scope (not just local to startAgentServices) so showStatusWindow can force
// an immediate recheck when the user reopens the tray popup after granting permission in System
// Settings — otherwise the banner can lag up to 5min behind the OS-level grant (the interval below).
const checkScreenRecordingPermission = () => {
  const granted = getScreenRecordingGranted();
  agentState.screenRecordingGranted = granted;
  if (granted === false && !lastNotifiedScreenRecordingMissing) {
    lastNotifiedScreenRecordingMissing = true;
    if (Notification.isSupported()) {
      new Notification({
        title: "Screen Recording permission needed",
        body: 'Your screenshots have stopped. Click the tray icon and use "Fix Screen Recording" to re-enable it.',
        silent: false,
      }).show();
    }
  } else if (granted === true) {
    lastNotifiedScreenRecordingMissing = false;
  }
  broadcastState();
};

/* ─────────────────────────────────────────────────────────────────
   Tray icon helpers
───────────────────────────────────────────────────────────────── */
const trayIconCache = new Map<string, Electron.NativeImage>();

const getTrayIcon = () => {
  // Use activityStartMs as fallback — same logic as status.html's effectivelyOnShift
  const effectivelyOnShift = agentState.isOnShift || activityStartMs !== null;
  const iconName = agentState.isAgentOnline
    ? effectivelyOnShift
      ? agentState.isIdle ? 'tray-idle.png' : 'tray-active.png'
      : 'tray-offline.png'
    : 'tray-offline.png';

  const cached = trayIconCache.get(iconName);
  if (cached) return cached;

  const iconPath = path.join(__dirname, '..', 'assets', iconName);
  try {
    const img = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    trayIconCache.set(iconName, img);
    return img;
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
        ? `Suprah AI - Timeproof Clock — Idle (${agentState.user?.fullName})`
        : `Suprah AI - Timeproof Clock — On Shift (${agentState.user?.fullName})`
      : agentState.isOnBreak
      ? `Suprah AI - Timeproof Clock — On Break (${agentState.user?.fullName})`
      : `Suprah AI - Timeproof Clock — ${agentState.user?.fullName}`
    : agentState.sessionExpired
      ? "Suprah AI - Timeproof Clock — Can't connect"
      : 'Suprah AI - Timeproof Clock — Not signed in';

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
    items.push({ type: 'separator' });
    items.push({ label: 'Sign Out', click: handleLogout });
    if (authCoordinator.hasCredential()) items.push({ label: 'Disconnect this computer', click: confirmDisconnect });
  } else {
    if (agentState.sessionExpired) items.push({ label: "Can't connect — close and reopen the tray app", enabled: false });
    if (agentState.connection?.state === 'signed_out') {
      items.push({ label: 'Sign in', click: () => { authCoordinator.signInWithDevice({ userInitiated: true }).catch(() => {}); } });
    }
    items.push({ label: 'Open Dashboard to Sign In', click: () => shell.openExternal(CRM_URL) });
    if (authCoordinator.hasCredential()) items.push({ label: 'Disconnect this computer', click: confirmDisconnect });
  }

  if (agentState.updateAvailable) {
    items.push({ type: 'separator' });
    items.push({ label: `Download latest version (v${agentState.updateAvailable.version})`, click: openUpdateDownload });
  }

  items.push({ type: 'separator' });
  items.push({ label: 'Quit', click: () => app.quit() });

  return Menu.buildFromTemplate(items);
};

/* ─────────────────────────────────────────────────────────────────
   Windows
───────────────────────────────────────────────────────────────── */
// Positions the status popup bottom-right of the CURRENT primary display — called every time
// the window is about to be shown (see showStatusWindow below), not just once at creation.
// Computing this only once, at creation time, was the actual bug behind "tray icon shows, but
// clicking it displays nothing": if the display config at creation (e.g. at auto-launch/login,
// before macOS/Windows finished enumerating monitors, or before/after a monitor gets
// connected/disconnected) differs from later, the window silently sits off whatever's actually
// visible now — indistinguishable from the app not responding at all.
const positionStatusWindow = () => {
  if (!statusWindow) return;
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const [, windowHeight] = statusWindow.getSize();
  statusWindow.setPosition(Math.round(width - 316), Math.round(height - windowHeight - 16));
};

// Tracks the in-flight loadFile() call so showStatusWindow can wait for it — see its comment.
let statusWindowLoadPromise: Promise<void> | null = null;

const createStatusWindow = () => {
  statusWindow = new BrowserWindow({
    width: 300,
    height: STATUS_HEIGHT_BASE,
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

  positionStatusWindow();
  // loadFile() used to be fire-and-forget, with showStatusWindow calling .show() on the very
  // next synchronous line — on a slow or antivirus-throttled disk read, .show() could fire
  // before this resolves. Since the window is transparent, an unpainted transparent window is
  // fully invisible — indistinguishable from the tray icon click doing nothing at all. Track
  // the promise so showStatusWindow can wait for it, and report a diagnostic on genuine
  // failure instead of it vanishing into an unhandled rejection with zero trace.
  const win = statusWindow;
  statusWindowLoadPromise = win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'status.html'))
    .then(() => {})
    .catch((err) => {
      reportDiagnostic('status_window_load_failed', 'Status window failed to load its content', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  statusWindow.on('blur', () => statusWindow?.hide());
  statusWindow.on('closed', () => { statusWindow = null; statusWindowLoadPromise = null; });
  statusWindow.webContents.on('unresponsive', () => {
    reportDiagnostic('status_window_unresponsive', 'Status window renderer stopped responding', { platform: process.platform });
  });
  statusWindow.webContents.on('responsive', () => {
    reportDiagnostic('status_window_responsive', 'Status window renderer recovered', { platform: process.platform });
  });
};

const showStatusWindow = async () => {
  const isFreshWindow = !statusWindow || statusWindow.isDestroyed();
  if (isFreshWindow) createStatusWindow();
  // On a freshly-created window, wait for its content to actually finish loading before
  // showing it — otherwise .show() can fire on a still-blank transparent window (see
  // createStatusWindow's comment), which is indistinguishable from the tray icon click doing
  // nothing. Capped at 3s so a genuinely stuck load doesn't block the click forever — it'll
  // just show blank in that pathological case instead of not showing at all.
  if (isFreshWindow && statusWindowLoadPromise) {
    await Promise.race([statusWindowLoadPromise, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  }
  if (statusWindow) {
    // Re-anchor to the CURRENT primary display every time — display config can change (monitor
    // connected/disconnected, resolution change) between opens, and createStatusWindow's own
    // initial placement can be wrong if it ran before the OS finished enumerating displays at
    // login. Without this, the window can end up permanently off-screen with no way to recover
    // short of a reinstall — the exact "tray icon shows, click does nothing" symptom.
    fitStatusWindow();
    positionStatusWindow();
    // Force an immediate recheck instead of waiting on the 5min interval — this is exactly the
    // moment a user comes back after granting Screen Recording via "Fix Now", so the banner
    // should clear right away instead of looking like the grant didn't take.
    if (process.platform === 'darwin') checkScreenRecordingPermission();
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
const CANNOT_CONNECT_MESSAGE = "Can't connect to your tray app. Please close the tray app, open it again, then try again on the website.";
const EXPIRED_NOTICE_DELAY_MS = 90_000;
const IDLE_RECORDING_SETTLE_CAP_MS = 35_000;

let sessionCheckInFlight = false;
let sessionEnding = false;

const getStoredToken = (): string | undefined => {
  const value = store.get('crm_token');
  return typeof value === 'string' && value ? value : undefined;
};

const describeApiError = (err: unknown, fallback: string): string => {
  if (isAuthRejection(err)) return CANNOT_CONNECT_MESSAGE;
  const message = (err as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
  return typeof message === 'string' && message ? message : fallback;
};

const applyRefreshedToken = (token: string): void => {
  store.set('crm_token', token);
  updateHeartbeatToken(token);
  updateScreenshotToken(token);
  updateSocketToken(token);
};

const isRefreshable = (token: string): boolean =>
  getAuthMode() === 'crm' && readTokenClaims(token)?.type === 'crm';

const setConnectionState = (state: ConnectionState | null, message?: string): void => {
  agentState.connection = state ? { state, message: message ?? '' } : null;
  broadcastState();
};

const deviceCipher = {
  isAvailable: (): boolean => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  },
  encrypt: (plain: string): string => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (encoded: string): string => safeStorage.decryptString(Buffer.from(encoded, 'base64')),
};

const askConnectionQuestion = async (prompt: ConfirmPrompt): Promise<boolean> => {
  const isRegister = prompt.type === 'register';
  const result = await dialog.showMessageBox({
    type: 'question',
    buttons: isRegister ? ['Connect & Continue', 'Cancel'] : ['Switch account', `Keep ${prompt.registeredName}`],
    defaultId: 0,
    cancelId: 1,
    title: isRegister ? 'Connect this computer' : 'Different account detected',
    message: isRegister ? `Connect this computer to ${prompt.accountName}?` : 'Different account detected',
    detail: isRegister
      ? `The Suprah tray app on this computer will sign in as ${prompt.accountName}.`
      : `This computer is set up for ${prompt.registeredName}. Switch to ${prompt.websiteName}?`,
  });
  return result.response === 0;
};

const showConnectionInfo = async (prompt: InfoPrompt): Promise<void> => {
  await dialog.showMessageBox({
    type: 'info',
    buttons: ['OK'],
    title: 'Shift in progress',
    message: prompt.registeredName
      ? `${prompt.registeredName} has a shift in progress on this computer.`
      : 'A shift is in progress on this computer.',
    detail: 'End that shift before switching accounts.',
  });
};

const authCoordinator = createAuthCoordinator({
  apiUrl: API_URL,
  meta: () => ({ label: os.hostname(), platform: process.platform, appVersion: app.getVersion() }),
  storage: {
    load: () => loadDeviceCredential(store, deviceCipher),
    save: (credential) => saveDeviceCredential(store, deviceCipher, credential),
    clear: () => clearDeviceCredential(store),
    exists: () => deviceCredentialExists(store),
    isPaused: () => isAutoSignInPaused(store),
    setPaused: (paused) => setAutoSignInPaused(store, paused),
  },
  getStoredToken,
  isAuthenticated: () => agentState.isAuthenticated,
  isOnShift: () => agentState.isOnShift,
  handleTrayAuth: (token) => handleTrayAuth(token),
  applyRefreshedToken,
  resetSession: () => resetSessionState(false),
  readUserId: (token) => (token ? readTokenClaims(token)?.userId ?? null : null),
  confirm: askConnectionQuestion,
  inform: (prompt) => {
    showConnectionInfo(prompt).catch(() => {});
  },
  setConnection: setConnectionState,
});

const confirmDisconnect = async (): Promise<void> => {
  if (agentState.isOnShift) {
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      title: 'Shift in progress',
      message: 'End your shift before disconnecting this computer.',
    });
    return;
  }
  const result = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Disconnect', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Disconnect this computer',
    message: 'Disconnect this computer from your Suprah account?',
    detail: 'This tray app will sign out and stop tracking. Press Start Shift on the website to connect it again.',
  });
  if (result.response !== 0) return;
  if ((await authCoordinator.disconnectThisComputer()) === 'none') return;
  resetSessionState(false);
  showStatusWindow();
};

const waitForIdleRecordingToSettle = async (capMs: number): Promise<void> => {
  const deadline = Date.now() + capMs;
  while (getIdleRecordingStatus() !== 'idle' && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
};

const scheduleExpiredNotice = (): void => {
  setTimeout(() => {
    if (!agentState.sessionExpired || agentState.isAuthenticated) return;
    if (!Notification.isSupported()) return;
    new Notification({
      title: "Can't connect",
      body: 'Your tray app lost its connection. Close it, open it again, then go back to the website.',
      silent: false,
    }).show();
  }, EXPIRED_NOTICE_DELAY_MS);
};

const resetSessionState = (expired: boolean): void => {
  stopAgentServices();
  activityStartMs = null;
  todayTotalActiveMs = 0;
  wallClockBaseMs = 0;
  wallClockBaseAt = null;
  store.delete('crm_token');
  store.delete('auth_mode');
  store.delete('user');
  agentState = {
    ...createAgentState(),
    sessionExpired: expired,
    screenRecordingGranted: agentState.screenRecordingGranted,
    updateAvailable: agentState.updateAvailable,
    screenshotsToday: agentState.screenshotsToday,
    connection: agentState.connection,
  };
  updateTrayIcon();
  tray?.setContextMenu(buildTrayMenu());
  broadcastState();
};

const enterSessionExpired = async (rejectedToken: string): Promise<void> => {
  if (sessionEnding || !agentState.isAuthenticated) return;
  sessionEnding = true;
  try {
    const wasOnShift = agentState.isOnShift || activityStartMs !== null;
    stopIdleVideoIfRecording('partial');
    await waitForIdleRecordingToSettle(IDLE_RECORDING_SETTLE_CAP_MS);
    if (getStoredToken() !== rejectedToken || !agentState.isAuthenticated) return;
    resetSessionState(wasOnShift);
    if (wasOnShift) scheduleExpiredNotice();
  } finally {
    sessionEnding = false;
  }
};

const recoverOrExpire = async (rejectedToken: string): Promise<void> => {
  const renewal = await authCoordinator.renewWithDevice(rejectedToken);
  if (renewal !== 'unusable' || getStoredToken() !== rejectedToken) return;
  await enterSessionExpired(rejectedToken);
};

const checkSessionToken = async (): Promise<void> => {
  const current = getStoredToken();
  if (sessionCheckInFlight || !current || !agentState.isAuthenticated) return;
  if (!isRefreshable(current) || !shouldRefreshNow(current, Date.now(), TOKEN_REFRESH_WINDOW_MS)) return;
  sessionCheckInFlight = true;
  try {
    const outcome = await refreshToken(API_URL, current);
    if (getStoredToken() !== current) return;
    if (outcome.kind === 'refreshed') applyRefreshedToken(outcome.token);
    else if (outcome.kind === 'authRejected') await recoverOrExpire(current);
  } finally {
    sessionCheckInFlight = false;
  }
};

const reportAuthRejected = async (rejectedToken: string): Promise<void> => {
  if (getAuthMode() !== 'crm' || sessionCheckInFlight || getStoredToken() !== rejectedToken) return;
  sessionCheckInFlight = true;
  try {
    const outcome = await probeToken(`${API_URL}/api/crm/me`, rejectedToken);
    if (getStoredToken() !== rejectedToken) return;
    if (outcome === 'rejected') await recoverOrExpire(rejectedToken);
  } finally {
    sessionCheckInFlight = false;
  }
};

const scheduleSessionCheck = (delayMs = 10_000): void => {
  setTimeout(() => { checkSessionToken().catch(() => {}); }, delayMs);
};

const restoreSavedSession = async (): Promise<void> => {
  const savedToken = getStoredToken();
  const savedUser = store.get('user') as User | undefined;
  if (!savedToken || !savedUser) {
    authCoordinator.signInWithDevice().catch(() => {});
    showStatusWindow();
    return;
  }
  let activeToken = savedToken;
  if (isRefreshable(savedToken)) {
    const outcome = await refreshToken(API_URL, savedToken);
    if (agentState.isAuthenticated) return;
    if (outcome.kind === 'authRejected') {
      resetSessionState(false);
      authCoordinator.signInWithDevice().catch(() => {});
      showStatusWindow();
      return;
    }
    if (outcome.kind === 'refreshed') {
      store.set('crm_token', outcome.token);
      activeToken = outcome.token;
    }
  }
  agentState.isAuthenticated = true;
  agentState.user = savedUser;
  agentState.isAgentOnline = true;
  updateTrayIcon();
  tray?.setContextMenu(buildTrayMenu());
  startAgentServices(activeToken);
  showStatusWindow();
};

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const UPDATE_FIRST_CHECK_DELAY_MS = 10_000;
const UPDATE_CHECK_JITTER_MS = 20_000;
const LAST_NOTIFIED_UPDATE_KEY = 'lastNotifiedUpdateVersion';

let updateCheckInFlight = false;
let updateNotification: Notification | null = null;

const announceUpdate = (version: string): void => {
  if (store.get(LAST_NOTIFIED_UPDATE_KEY) === version) return;
  store.set(LAST_NOTIFIED_UPDATE_KEY, version);
  if (!Notification.isSupported()) return;
  updateNotification = new Notification({
    title: 'New version available',
    body: `Version ${version} is ready to download. Open the tray app to get it.`,
    silent: true,
  });
  updateNotification.on('click', () => { showStatusWindow(); });
  updateNotification.show();
};

const runUpdateCheck = async (): Promise<void> => {
  if (updateCheckInFlight || !app.isPackaged) return;
  updateCheckInFlight = true;
  try {
    const latest = await fetchLatestVersion();
    if (!latest || !isNewerVersion(latest, app.getVersion())) return;
    if (agentState.updateAvailable?.version === latest) return;
    agentState.updateAvailable = { version: latest };
    announceUpdate(latest);
    broadcastState();
  } finally {
    updateCheckInFlight = false;
  }
};

const requestUpdateCheck = (): void => {
  setTimeout(() => { runUpdateCheck().catch(() => {}); }, Math.floor(Math.random() * UPDATE_CHECK_JITTER_MS));
};

const openUpdateDownload = (): void => {
  if (!agentState.updateAvailable) return;
  shell.openExternal(getInstallerUrl()).catch(() => {});
};

let lastSyncFailReportedAt = 0;
const SYNC_FAIL_REPORT_COOLDOWN_MS = 10 * 60 * 1000;

const syncShiftState = async (token: string, retries = 3): Promise<void> => {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.get(`${API_URL}${getShiftStateUrl()}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10_000,
      });
      const s = data?.data;
      if (!s) return;
      // Snapshot BEFORE this sync overwrites agentState.isOnBreak below — needed so the
      // break-in/break-out proof-of-work capture further down only fires on a genuine
      // transition this sync just discovered, not on every subsequent 60s resync tick
      // while already on a break the app already knew about.
      const prevIsOnBreakForCapture = agentState.isOnBreak;
      const STALE_SHIFT_MS = 16 * 60 * 60 * 1000;
      const elapsedMs = s.shiftStartedAt
        ? Date.now() - new Date(s.shiftStartedAt).getTime()
        : 0;
      const isStaleShift = !!s.isOnShift && elapsedMs > STALE_SHIFT_MS;

      agentState.isOnShift = !!s.isOnShift;
      agentState.isOnBreak = s.isOnShift ? !!s.isOnBreak : false;
      agentState.shiftStartedAt = s.isOnShift
        ? (s.shiftStartedAt ?? null)
        : null;
      agentState.breakStartedAt = s.isOnShift
        ? (s.breakStartedAt ?? null)
        : null;
      agentState.totalBreakSeconds = s.isOnShift
        ? (s.totalBreakSeconds ?? 0)
        : 0;
      agentState.todayTotalWorkedSeconds = s.todayTotalWorkedSeconds ?? 0;
      wallClockBaseMs = (s.currentSessionSeconds ?? 0) * 1000;
      wallClockBaseAt = s.isOnShift && !s.isOnBreak ? Date.now() : null;
      agentState.wallClockBaseMs = wallClockBaseMs;
      agentState.wallClockBaseAt = wallClockBaseAt;
      todayTotalActiveMs = (s.todayTotalActiveSeconds ?? 0) * 1000;
      agentState.todayTotalActiveMs = todayTotalActiveMs;

      // Reset activityStartMs if it predates today’s MDT midnight (UTC midnight +6h) to avoid showing yesterday’s elapsed time as today’s work.
      const MDT_OFFSET_MS = -6 * 60 * 60 * 1000; // UTC-6
      const nowInMDT = new Date(Date.now() + MDT_OFFSET_MS);
      const todayMDTDateStr = nowInMDT.toISOString().split("T")[0];
      const todayMDTMidnightUTC =
        new Date(todayMDTDateStr + "T00:00:00.000Z").getTime() - MDT_OFFSET_MS;
      if (activityStartMs !== null && activityStartMs < todayMDTMidnightUTC) {
        activityStartMs = null;
        agentState.activityStartMs = null;
        stopScreenshots();
        agentState.nextScreenshotIn = null;
      }

      // Sync activity with server state; socket handles real-time, syncShiftState patches missed events,
      // stale shifts (>16h) show on-shift but require manual end before new start.
      const isNowTracking =
        agentState.isOnShift &&
        !agentState.isOnBreak &&
        !agentState.isIdle &&
        !isStaleShift;

      if (
        agentState.isOnShift &&
        agentState.isOnBreak &&
        activityStartMs !== null
      ) {
        // CONFIRMED on break but local interval is still running → missed break-in event.
        // Same proof-of-work rationale as the live socket-driven capture — this covers the
        // case that fix couldn't: the break-in socket event arrived (or fired) while this
        // machine was asleep/disconnected, so it was never locally acted on until this
        // resync caught up. Without this, a break taken while the socket event is missed
        // gets zero break-in evidence, even though break-out (captured when the machine
        // is normally awake and connected again) still does.
        if (!prevIsOnBreakForCapture) {
          const currentToken = store.get('crm_token') as string | undefined;
          if (currentToken && getAuthMode() === 'crm') {
            captureAndUploadOnce(API_URL, currentToken, false, 'break-in').catch(() => {});
          }
        }
        // Flush the interval up to when the break started so work time is preserved.
        const stopAt = agentState.breakStartedAt
          ? new Date(agentState.breakStartedAt).getTime()
          : Date.now();
        const durationMs = Math.max(0, stopAt - activityStartMs);
        const tkn = store.get("crm_token") as string | undefined;
        if (tkn && durationMs >= 30_000) {
          axios
            .post(
              `${API_URL}${getActivityIntervalUrl()}`,
              {
                startAt: new Date(activityStartMs).toISOString(),
                endAt: new Date(stopAt).toISOString(),
              },
              { headers: { Authorization: `Bearer ${tkn}` }, timeout: 10_000 },
            )
            .then(() => {
              todayTotalActiveMs += durationMs;
              agentState.todayTotalActiveMs = todayTotalActiveMs;
              broadcastState();
            })
            .catch(() => {});
        }
        activityStartMs = null;
        agentState.activityStartMs = null;
        stopScreenshots();
        agentState.nextScreenshotIn = null;
      } else if (!agentState.isOnShift && activityStartMs !== null) {
        // Clear local timer state when server confirms off-shift but timeout event was missed.
        activityStartMs = null;
        agentState.activityStartMs = null;
        stopScreenshots();
        agentState.nextScreenshotIn = null;
      } else if (isNowTracking && activityStartMs === null) {
        // Missed break-out counterpart to the missed-break-in capture above — the socket
        // event that would normally trigger this (see connectSocket's callback) can be
        // missed the same way (asleep/disconnected machine), leaving break-out evidence
        // as the only piece of a break's proof-of-work if not also handled here.
        if (prevIsOnBreakForCapture && !agentState.isOnBreak) {
          const currentToken = store.get('crm_token') as string | undefined;
          if (currentToken && getAuthMode() === 'crm') {
            captureAndUploadOnce(API_URL, currentToken, false, 'break-out').catch(() => {});
          }
        }
        // Auto-resume tracking if shift <5min old or from today; older unclosed shifts stay paused for manual resume.
        const SHIFT_AUTO_RESUME_MS = 5 * 60 * 1000;
        const shiftStartedAtMs = agentState.shiftStartedAt
          ? new Date(agentState.shiftStartedAt).getTime()
          : 0;
        const shiftStartedRecently =
          shiftStartedAtMs > 0 &&
          Date.now() - shiftStartedAtMs < SHIFT_AUTO_RESUME_MS;
        const isFromToday = !!s.isShiftFromToday;

        if (shiftStartedRecently || isFromToday) {
          const serverIntervalStart = s.currentIntervalStartAt
            ? new Date(s.currentIntervalStartAt).getTime()
            : null;
          if (
            serverIntervalStart &&
            serverIntervalStart >= shiftStartedAtMs &&
            serverIntervalStart <= Date.now()
          ) {
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

      // Watchdog: restart screenshot interval if it dies while on‑shift (not on break/idle, activityStartMs set); syncShiftState heals gaps within 60s.
      if (isNowTracking && activityStartMs !== null && !isScreenshotRunning()) {
        startScreenshots(API_URL, token);
        agentState.nextScreenshotIn = new Date(
          Date.now() + 10 * 60 * 1000,
        ).toISOString();
      }

      broadcastState();
      return;
    } catch (err) {
      lastErr = err;
      if (isAuthRejection(err)) {
        reportAuthRejected(token).catch(() => {});
        return;
      }
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 3_000));
      }
    }
  }
  // All retries failed — socket events will eventually correct the state, but this used to
  // leave zero trace of why. Throttled report so a genuine extended outage doesn't spam.
  const now = Date.now();
  if (now - lastSyncFailReportedAt > SYNC_FAIL_REPORT_COOLDOWN_MS) {
    lastSyncFailReportedAt = now;
    const axiosErr = lastErr as { response?: { status?: number }; message?: string };
    reportDiagnostic('sync_shift_state_failed', 'syncShiftState exhausted all retries', {
      status: axiosErr?.response?.status ?? null,
      message: axiosErr?.message ?? String(lastErr),
    });
  }
};

let sessionCheckIntervalId: ReturnType<typeof setInterval> | null = null;
let activityCheckpointIntervalId: ReturnType<typeof setInterval> | null = null;
const ACTIVITY_CHECKPOINT_MS = 10 * 60 * 1000;
const IDLE_STRETCH_BACKDATE_CAP_MS = (IDLE_THRESHOLD_SEC + 60) * 1000;
const IDLE_VIDEO_BOOKEND_MS = 2 * 60 * 1000;
const IDLE_STAGE_WINDOW_MS = 600_000;

/**
 * Commit current active segment (activityStartMs → endAt) into todayTotalActiveMs.
 * Ensures long continuous activity isn’t lost on crash/restart by periodic checkpoints.
 * Returns true if committed or nothing to commit; false only if POST failed —
 * callers must check before rolling activityStartMs forward to avoid discarding time.
 */
let lastCheckpointFailReportedAt = 0;
const CHECKPOINT_FAIL_REPORT_COOLDOWN_MS = 10 * 60 * 1000;

const commitActiveSegment = async (endAtRaw: Date): Promise<boolean> => {
  if (activityStartMs === null) return true;
  // A backdated endAt (e.g. onIdleChange's idle-onset estimate) can land before
  // activityStartMs if activityStartMs was already advanced past that point by an intervening
  // periodic checkpoint that didn't yet know idle time was building up. Clamping here — instead
  // of letting durationMs go negative — protects every caller uniformly: it lands on the
  // existing "nothing meaningful to commit" no-op path below rather than silently discarding
  // whatever time was actually tracked. Reported so this edge case is visible if it still
  // happens after the periodic checkpoint's own idle-awareness fix.
  const endAt = endAtRaw.getTime() < activityStartMs ? new Date(activityStartMs) : endAtRaw;
  if (endAt.getTime() !== endAtRaw.getTime()) {
    reportDiagnostic('activity_segment_clamped', 'commitActiveSegment endAt clamped to activityStartMs', {
      requestedEndAt: endAtRaw.toISOString(),
      activityStartMs,
    });
  }
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
  } catch (err) {
    const now = Date.now();
    if (now - lastCheckpointFailReportedAt > CHECKPOINT_FAIL_REPORT_COOLDOWN_MS) {
      lastCheckpointFailReportedAt = now;
      const axiosErr = err as { response?: { status?: number }; message?: string };
      reportDiagnostic('activity_checkpoint_failed', 'Activity-interval checkpoint POST failed', {
        status: axiosErr?.response?.status ?? null,
        message: axiosErr?.message ?? String(err),
      });
    }
    return false;
  }
};

const CAPTURE_RETRY_ATTEMPTS = 3;
const CAPTURE_RETRY_DELAY_MS = 3_000;

const captureIdleEvidenceWithRetry = async (token: string, idleStage?: 1 | 2 | 3): Promise<boolean> => {
  for (let attempt = 1; attempt <= CAPTURE_RETRY_ATTEMPTS; attempt++) {
    const ok = await captureAndUploadOnce(API_URL, token, true, undefined, idleStage);
    if (ok) return true;
    if (attempt < CAPTURE_RETRY_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, CAPTURE_RETRY_DELAY_MS));
    }
  }
  return false;
};

// clearStretch defaults to true only for 'partial' (the whole idle stretch ended because
// activity resumed) — a 'confirmed' stop at a stage boundary (chunk 1->2, chunk 2->3) keeps
// the stretch anchor alive since a new chunk starts immediately after. Stage 3's 'confirmed'
// stop passes clearStretch explicitly, since no chunk 4 follows (the shift is auto-ending).
const stopIdleVideoIfRecording = (proofStatus: 'partial' | 'confirmed', clearStretch: boolean = proofStatus === 'partial'): void => {
  if (getIdleRecordingStatus() !== 'recording') return;
  const currentToken = store.get('crm_token') as string | undefined;
  if (!currentToken || idleStretchStartMs === null || currentIdleChunkIndex === null) return;
  const startMs = idleStretchStartMs;
  const chunkIndex = currentIdleChunkIndex;
  agentState.idleRecordingActive = false;
  stopAndUploadIdleRecording(API_URL, currentToken, toShiftDate(), startMs, chunkIndex, proofStatus).catch(() => {});
  if (clearStretch) {
    idleStretchStartMs = null;
    currentIdleChunkIndex = null;
  }
  broadcastState();
};

// Starts one idle-video chunk (1, 2, or 3). Chunk 1 establishes idleStretchStartMs (the
// backdated true onset of the stretch); chunks 2/3 reuse it so all chunks of the same idle
// stretch group under one backend storage key. Common gates (CRM mode, department toggle,
// recorder free, still on-shift) apply to every chunk; chunk-specific pre-checks (e.g. chunk
// 1's activityStartMs guard) are the caller's responsibility.
const startIdleVideoChunk = async (chunkIndex: 1 | 2 | 3): Promise<boolean> => {
  if (getAuthMode() !== "crm") return false;
  if (!agentState.user?.idleVideoProofEnabled) return false;
  if (getIdleRecordingStatus() !== "idle") return false;
  const wasTracking = agentState.isOnShift && !agentState.isOnBreak;
  if (!wasTracking) return false;

  let resolvedStartMs: number | null = null;
  if (chunkIndex === 1) {
    const rawIdleSeconds = getLastIdleSeconds();
    const sampleReliable = isLastIdleSampleReliable();
    const candidateStartMs = Date.now() - rawIdleSeconds * 1000;
    const ceilingMs = Date.now() - IDLE_STRETCH_BACKDATE_CAP_MS;
    const lowerBoundMs = Math.max(activityStartMs ?? candidateStartMs, ceilingMs);
    resolvedStartMs = Math.max(candidateStartMs, lowerBoundMs);
    if (!sampleReliable) resolvedStartMs = Date.now();

    reportDiagnostic('idle_stretch_start_computed', 'startIdleVideoChunk chunk-1 anchor computed', {
      rawIdleSeconds,
      sampleReliable,
      candidateStartMs,
      activityStartMs,
      resolvedStartMs,
      windowEndMs: resolvedStartMs + IDLE_STAGE_WINDOW_MS,
    });
    if (resolvedStartMs !== candidateStartMs) {
      reportDiagnostic('idle_stretch_start_clamped', 'startIdleVideoChunk idleStretchStartMs clamped', {
        rawIdleSeconds,
        sampleReliable,
        candidateStartMs,
        activityStartMs,
        resolvedStartMs,
      });
    }
  }

  const windowEndMs = chunkIndex === 1
    ? resolvedStartMs! + IDLE_STAGE_WINDOW_MS
    : Date.now() + IDLE_STAGE_WINDOW_MS;

  const started = await startIdleRecording(windowEndMs, IDLE_VIDEO_BOOKEND_MS);
  if (!started) return false;

  if (chunkIndex === 1) {
    idleStretchStartMs = resolvedStartMs!;
  }
  currentIdleChunkIndex = chunkIndex;
  agentState.idleRecordingActive = true;
  if (chunkIndex === 1 && Notification.isSupported()) {
    new Notification({
      title: "Idle proof recording started",
      body: "A short screen clip is being recorded as proof of this idle period.",
      silent: true,
    }).show();
  }
  broadcastState();
  return true;
};

let agentServicesStarted = false;

const startAgentServices = async (token: string) => {
  if (agentServicesStarted) return;
  agentServicesStarted = true;
  const SCREENSHOT_INTERVAL_MS = 10 * 60 * 1000;

  // Configure endpoint paths and screenshot mode based on auth mode
  const authMode = getAuthMode();
  if (authMode === "main") {
    setHeartbeatPath("/api/timeclock/heartbeat");
    setSkipCaptures(true); // screenshots not yet supported for main-mode users
  } else {
    setHeartbeatPath("/api/crm/timeproof/heartbeat");
    // Per-user screenshot exemption (CrmUser.screenshotExempt); applies only after next login/reconnect with fresh token, not mid-session.
    setSkipCaptures(!!agentState.user?.screenshotExempt || agentState.user?.screenshotsRequired === false);
  }

  setMainMonitorOnly(!!agentState.user?.mainMonitorOnly);
  setIdleDetectionExempt(!!agentState.user?.idleDetectionExempt);

  setOnScreenshotsRequired((required) => {
    if (getAuthMode() === "main") return;
    setSkipCaptures(!!agentState.user?.screenshotExempt || !required);
  });

  setOnAuthRejected((rejectedToken) => {
    reportAuthRejected(rejectedToken).catch(() => {});
  });

  // Re-apply department flags on startup (not just handleTrayAuth) so Web Dev users keep
  // mainMonitorOnly/idleDetectionExempt across auto-update relaunches; otherwise they silently reset to false.
  checkScreenRecordingPermission();
  screenRecordingCheckIntervalId = setInterval(
    checkScreenRecordingPermission,
    5 * 60 * 1000,
  );

  // Notify the user when screen capture itself fails (upload failures are queued offline)
  setCaptureFailedCallback(() => {
    if (Notification.isSupported()) {
      new Notification({
        title: "Screenshot capture failed",
        body: "TimeProof could not capture your screen. Please check your screen recording permissions. Your admin may see a gap in your activity.",
        silent: false,
      }).show();
    }
  });

  // Small on-screen count so the user can see for themselves how many screenshots have
  // actually gone through today, instead of just trusting the timer kept ticking.
  setCaptureSucceededCallback((count) => {
    agentState.screenshotsToday = count;
    broadcastState();
  });

  // Guard screenshot loop against break state — skips capture ticks while on break, 
  // even if break-in socket event was missed and stopScreenshots() wasn’t called.
  setOnBreakGetter(() => agentState.isOnBreak);

  sessionCheckIntervalId =
    authMode === "crm"
      ? setInterval(safeAsync(checkSessionToken, 'session-check'), SESSION_CHECK_INTERVAL_MS)
      : null;

  startIdleMonitor(
    async (isIdle) => {
      const wasIdle = agentState.isIdle;
      agentState.isIdle = isIdle;

      // Activity tracking only applies while the user is clocked in and not on break.
      // Deliberately NOT checking activityStartMs here — the "became active" branch
      // below needs wasTracking to stay true even when activityStartMs is null
      // (that's exactly the case it exists to repopulate).
      const wasTracking = agentState.isOnShift && !agentState.isOnBreak;
      // Whether there was an actual open activity segment to interrupt — false in
      // the "Shift Open — Tap Resume" limbo state (activityStartMs already null),
      // where nothing is genuinely running yet. Scoped to the "going idle"
      // side-effects below only, so they stop firing a false "went idle" signal
      // for a segment that was never open, matching commitActiveSegment's own gate.
      const hadOpenSegment = wasTracking && activityStartMs !== null;

      const IDLE_BACKDATE_CAP_SEC = IDLE_THRESHOLD_SEC + 60;

      if (isIdle && !wasIdle) {
        if (hadOpenSegment) {
          const idleSec = Math.min(powerMonitor.getSystemIdleTime(), IDLE_BACKDATE_CAP_SEC);
          const endAt = new Date(Date.now() - idleSec * 1000);
          await commitActiveSegment(endAt);
          activityStartMs = null;
          agentState.activityStartMs = null;
        }
        stopScreenshots();
        agentState.nextScreenshotIn = null;

        if (hadOpenSegment) pingHeartbeat();

        if (hadOpenSegment && Notification.isSupported()) {
          const flaggedIdleSec = Math.min(powerMonitor.getSystemIdleTime(), IDLE_BACKDATE_CAP_SEC);
          const flaggedMin = Math.floor(flaggedIdleSec / 60);
          const flaggedSec = flaggedIdleSec % 60;
          new Notification({
            title: "You are idle",
            body: `No mouse/keyboard input detected for ${flaggedMin}m ${flaggedSec}s. Timer and screenshots paused.`,
            silent: false,
          }).show();
        }

        if (hadOpenSegment) {
          reportDiagnostic("idle_detected", "User flagged idle", {
            idleSeconds: powerMonitor.getSystemIdleTime(),
            idleSecondsHistory: getIdleSecondsHistory(),
            platform: process.platform,
            wasTracking,
          });
        }

        if (
          hadOpenSegment &&
          getAuthMode() === "crm" &&
          !agentState.user?.screenshotExempt
        ) {
          const currentToken = store.get("crm_token") as string | undefined;
          if (currentToken) {
            const videoWasActive = agentState.idleRecordingActive;
            captureIdleEvidenceWithRetry(currentToken, 1).then((screenshotOk) => {
              if (!screenshotOk || (agentState.user?.idleVideoProofEnabled && !videoWasActive)) {
                reportDiagnostic("idle_evidence_incomplete", "Confirmed-idle alert fired without full evidence", {
                  screenshotCaptured: screenshotOk,
                  videoWasActive,
                  idleVideoProofEnabled: !!agentState.user?.idleVideoProofEnabled,
                });
              }
            });
          }
        }

        // Chunk 1 (started at the 60s recording-trigger) ends here; immediately
        // start chunk 2 so the 10-20min window is also covered, not just 1-10min.
        stopIdleVideoIfRecording("confirmed");
        if (hadOpenSegment) {
          startIdleVideoChunk(2);
        }
      } else if (!isIdle && wasIdle) {
        stopIdleVideoIfRecording("partial");
        // User became active — resume only if clocked in and not on break
        if (wasTracking) {
          activityStartMs = Date.now();
          agentState.activityStartMs = activityStartMs;
          const currentToken = store.get("crm_token") as string | undefined;
          if (currentToken && agentState.isAuthenticated) {
            startScreenshots(API_URL, currentToken);
            const nextIn = Date.now() + SCREENSHOT_INTERVAL_MS;
            agentState.nextScreenshotIn = new Date(nextIn).toISOString();
          }
          pingHeartbeat();
        }
      }

      broadcastState();
    },
    (idleSeconds, exempt) => {
      reportDiagnostic("idle_periodic_check", "Periodic idle-check trace", {
        idleSeconds,
        idleDetectionExempt: exempt,
        isOnShift: agentState.isOnShift,
        isOnBreak: agentState.isOnBreak,
        platform: process.platform,
      });
    },
    async (shouldRecord) => {
      if (!shouldRecord) return;
      const wasTracking = agentState.isOnShift && !agentState.isOnBreak;
      if (!wasTracking || activityStartMs === null) return;
      await startIdleVideoChunk(1);
    },
    async (stage, idleSeconds) => {
      // Stages 2 (20min) and 3 (30min) — stage 1 (10min) is the existing
      // isIdle transition above, unchanged. Each stage stops the chunk that's
      // been recording since the previous stage, captures a fresh stage-
      // tagged screenshot, and (stage 2 only) starts the next chunk — stage 3
      // starts no further chunk since the shift is about to auto-end.
      if (getAuthMode() !== "crm") return;
      const wasTracking = agentState.isOnShift && !agentState.isOnBreak;
      if (!wasTracking) return;
      const currentToken = store.get("crm_token") as string | undefined;
      if (!currentToken) return;

      stopIdleVideoIfRecording("confirmed", stage === 3);

      if (!agentState.user?.screenshotExempt) {
        captureIdleEvidenceWithRetry(currentToken, stage).then((screenshotOk) => {
          if (!screenshotOk) {
            reportDiagnostic("idle_evidence_incomplete", "Idle escalation stage fired without a screenshot", {
              stage,
              idleSeconds,
            });
          }
        });
      }

      if (stage === 2) {
        await startIdleVideoChunk(3);
      }

      pingHeartbeat();
      reportDiagnostic("idle_stage_reached", "Idle escalation stage reached", { stage, idleSeconds });
      broadcastState();
    },
  );

  activityCheckpointIntervalId = setInterval(safeAsync(async () => {
    if (
      !agentState.isOnShift ||
      agentState.isOnBreak ||
      agentState.isIdle ||
      activityStartMs === null
    )
      return;
    const nowMs = Date.now();
    // Raw idle time may already be building up even though it isn't CONFIRMED yet
    // (agentState.isIdle only flips true after the full 10-min debounce) — blindly committing
    // "now" as the segment end would wrongly count that buildup as active time. The LATER
    // confirmed-idle backdate (onIdleChange) then computes an endAt earlier than whatever
    // activityStartMs this tick just advanced to, silently discarding that whole stretch (see
    // commitActiveSegment's clamp). Mirror onIdleChange's own backdating here — same source,
    // same 30s floor — so both mechanisms agree on what actually counts as active.
    const rawIdleMs = powerMonitor.getSystemIdleTime() * 1000;
    const commitEndAt = rawIdleMs > 30_000 ? new Date(nowMs - rawIdleMs) : new Date(nowMs);
    const committed = await commitActiveSegment(commitEndAt);
    // Only roll the start point forward if the commit actually succeeded —
    // otherwise this chunk is silently dropped (activityStartMs would move to
    // "now" while todayTotalActiveMs never received the duration), and every
    // subsequent checkpoint keeps re-losing time the same way. Leaving
    // activityStartMs untouched means the next tick retries the FULL
    // accumulated duration instead.
    if (committed) {
      // Advance to the real "now", not commitEndAt — any raw idle time since commitEndAt is
      // genuine dead time, correctly left uncovered rather than folded into the next segment.
      activityStartMs = nowMs;
      agentState.activityStartMs = activityStartMs;
    }
  }, 'activity-checkpoint'), ACTIVITY_CHECKPOINT_MS);

  // Check every 30s if break has run 1 minute past the 1h limit — warn the
  // user once per break session, 4 minutes before the backend escalates to
  // their admin/manager at the 5-minute mark (see BREAK_ADMIN_NOTIFY_SECONDS
  // in crmTimeproof.controller.ts) — a short heads-up to wrap up before
  // their admin gets involved, not a "your admin already knows" message.
  const BREAK_WARNING_SECONDS = 60 * 60 + 1 * 60;
  breakExceededNotified = false;
  breakNotifyIntervalId = setInterval(() => {
    if (!agentState.isOnBreak || !agentState.breakStartedAt) {
      breakExceededNotified = false;
      return;
    }
    if (breakExceededNotified) return;
    const breakSecs = Math.floor(
      (Date.now() - new Date(agentState.breakStartedAt).getTime()) / 1000,
    );
    if (breakSecs >= BREAK_WARNING_SECONDS && Notification.isSupported()) {
      breakExceededNotified = true;
      new Notification({
        title: "Break time exceeded",
        body: "You've gone over your 1-hour break. Please wrap up soon — your admin will be notified shortly if it continues.",
        silent: false,
      }).show();
    }
  }, 30_000);

  // Local last-resort fallback only (see AUTO_CLOCKOUT_IDLE_MS above) — the
  // primary "done and forgot to end shift" auto-clockout is now the backend's
  // staged idle escalation (stage 3, 30 min), which is clamp-protected and
  // evidence-attached. This raw 35-min check exists purely so a shift still
  // ends eventually if the backend is genuinely unreachable — checked
  // regardless of hours already rendered, same reasoning as before (an
  // early-out with only a few hours rendered still needs protection).
  // Checked every 60s against the OS's own idle-time counter (not our 30s
  // poll cadence) so it fires close to the 35-minute mark regardless of when
  // the last check happened to run.
  autoClockoutTriggeredForThisIdleStretch = false;
  autoClockoutCheckIntervalId = setInterval(safeAsync(async () => {
    if (!agentState.isOnShift || agentState.isOnBreak) {
      autoClockoutTriggeredForThisIdleStretch = false;
      return;
    }
    const idleMs = powerMonitor.getSystemIdleTime() * 1000;
    if (idleMs < AUTO_CLOCKOUT_IDLE_MS) {
      autoClockoutTriggeredForThisIdleStretch = false;
      return;
    }
    if (autoClockoutTriggeredForThisIdleStretch) return;

    autoClockoutTriggeredForThisIdleStretch = true;
    const result = await performClockAction(
      "time-out",
      "Auto clock-out — idle 35+ minutes (local fallback — backend unreachable)",
    );
    if (result.success && Notification.isSupported()) {
      new Notification({
        title: "Shift ended automatically",
        body: "You were inactive for 30+ minutes — your shift was clocked out. Click Resume if you're still working.",
        silent: false,
      }).show();
    }
  }, 'auto-clockout'), 60_000);

  startHeartbeat(API_URL, token, () => {
    const isOnBreak = agentState.isOnBreak;
    const isOnShift = agentState.isOnShift;
    const breakDurationSeconds =
      isOnBreak && agentState.breakStartedAt
        ? Math.floor(
            (Date.now() - new Date(agentState.breakStartedAt).getTime()) / 1000,
          )
        : 0;
    // Report activityStartMs (this machine's clock). The CRM browser runs on the
    // same machine, so it computes (Date.now() - activityStartMs) in the SAME clock
    // domain → both timers match exactly. Reporting a server timestamp here would
    // mix the machine clock (CRM's Date.now()) with the server clock and surface
    // any clock skew as visible drift between the two displays.
    const currentIntervalStartAt = activityStartMs
      ? new Date(activityStartMs).toISOString()
      : null;
    return {
      isOnBreak,
      breakDurationSeconds,
      isOnShift,
      currentIntervalStartAt,
    };
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
      const wasTracking =
        prevIsOnShift &&
        !prevIsOnBreak &&
        !agentState.isIdle &&
        activityStartMs !== null;
      // Detect a break-out event specifically so we can force-resume when the tray was in
      // "Tap Resume" state (activityStartMs=null, isOnBreak already false locally) and thus
      // prevIsOnBreak=false — meaning justEndedBreak would be false, but we still need to resume.
      const isBreakOutEvent =
        "isOnBreak" in partial &&
        (partial as { isOnBreak: boolean }).isOnBreak === false &&
        !("isOnShift" in partial);

      agentState = { ...agentState, ...partial };
      agentState.isAgentOnline = true;

      // Toggle the wall-clock ticking flag immediately on transitions instead
      // of waiting for the next 60s syncShiftState poll — wallClockBaseMs
      // itself (the accumulated figure) still only refreshes on that poll,
      // so a resumed session may briefly over/undercount until the next one,
      // same self-correcting tolerance as the rest of this mechanism.
      wallClockBaseAt =
        agentState.isOnShift && !agentState.isOnBreak ? Date.now() : null;
      agentState.wallClockBaseAt = wallClockBaseAt;

      // Capture whether shift/break state changed BEFORE tracking transitions so we
      // can call pingHeartbeat() AFTER activityStartMs is correctly set/cleared.
      const shiftStateChanged =
        agentState.isOnBreak !== prevIsOnBreak ||
        agentState.isOnShift !== prevIsOnShift;

      if (prevIsOnBreak && !agentState.isOnBreak) {
        breakExceededNotified = false;

        // Correct a stale idle flag on break-resume — idle.ts only re-samples
        // powerMonitor.getSystemIdleTime() on its own 30s poll, so agentState.isIdle
        // can still read true (set while genuinely away during the break) for up to
        // 30s after the user has already clicked Resume — real input that itself
        // proves they're active. Left uncorrected, isNowTracking below evaluates
        // false right when it should flip true, so tracking/screenshots don't
        // resume and the UI shows "Idle" for up to 30s after a real lunch-break
        // return (reported as "flagged idle immediately after resuming").
        agentState.isIdle = false;
        forceIdleState(false);
      }

      if (!prevIsOnShift && agentState.isOnShift) {
        agentState.isIdle = false;
        forceIdleState(false);
      }

      const isNowTracking =
        agentState.isOnShift && !agentState.isOnBreak && !agentState.isIdle;

      // Break-in/break-out proof-of-work shots — evaluated independently of the
      // wasTracking/isNowTracking branches below (NOT nested inside them). Nesting
      // this under wasTracking previously required activityStartMs to already be
      // non-null at the moment break-in fired, which isn't guaranteed (e.g. Start
      // Shift immediately followed by Break, before that assignment lands) — this
      // must fire on every genuine isOnBreak transition regardless of that timing.
      if (agentState.isOnBreak && !prevIsOnBreak) {
        const currentToken = store.get('crm_token') as string | undefined;
        if (currentToken && getAuthMode() === 'crm') {
          captureAndUploadOnce(API_URL, currentToken, false, 'break-in').catch(() => {});
        }
      } else if (!agentState.isOnBreak && prevIsOnBreak) {
        const currentToken = store.get('crm_token') as string | undefined;
        if (currentToken && getAuthMode() === 'crm') {
          captureAndUploadOnce(API_URL, currentToken, false, 'break-out').catch(() => {});
        }
      }

      if (wasTracking && !isNowTracking) {
        // Clocked out or went on break — save the current active interval (fire-and-forget)
        if (activityStartMs !== null) {
          const endAt = new Date();
          const durationMs = endAt.getTime() - activityStartMs;
          const currentToken = store.get("crm_token") as string | undefined;
          if (currentToken && durationMs >= 30_000) {
            axios
              .post(
                `${API_URL}${getActivityIntervalUrl()}`,
                {
                  startAt: new Date(activityStartMs).toISOString(),
                  endAt: endAt.toISOString(),
                },
                {
                  headers: { Authorization: `Bearer ${currentToken}` },
                  timeout: 10_000,
                },
              )
              .then(() => {
                todayTotalActiveMs += durationMs;
                agentState.todayTotalActiveMs = todayTotalActiveMs;
                broadcastState();
              })
              .catch(() => {});
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
          ? new Date(agentState.shiftStartedAt).getTime()
          : 0;
        const shiftStartedRecently =
          shiftStartedAtMs > 0 &&
          Date.now() - shiftStartedAtMs < SHIFT_AUTO_RESUME_MS;
        const justEndedBreak = prevIsOnBreak && !agentState.isOnBreak;

        if (
          justEndedBreak ||
          shiftStartedRecently ||
          (isBreakOutEvent && activityStartMs === null)
        ) {
          activityStartMs = Date.now();
          agentState.activityStartMs = activityStartMs;
          const nextIn = Date.now() + SCREENSHOT_INTERVAL_MS;
          agentState.nextScreenshotIn = new Date(nextIn).toISOString();
          const liveToken = getStoredToken();
          if (liveToken) startScreenshots(API_URL, liveToken);
        }
      }

      // Ping AFTER activityStartMs is set/cleared so the DB gets the correct
      // currentIntervalStartAt — calling it before would send null on clock-in.
      if (shiftStateChanged) {
        pingHeartbeat();
      }

      broadcastState();
      const queueToken = getStoredToken();
      if (queueToken) flushQueue(API_URL, queueToken).catch(() => {});
    },
    () => {
      // Read live — this callback outlives the initial login and must not resync
      // using the first-login token forever if it's since rotated for the same user.
      const currentToken = store.get('crm_token') as string | undefined;
      if (currentToken) syncShiftState(currentToken);
    },
    () => {
      requestUpdateCheck();
    },
  );

  // Sync state. syncShiftState already handles auto-resume tracking (gated to
  // shifts started within the last 5 minutes) — DO NOT add an unconditional
  // auto-start here. An older open shift (e.g. forgotten clock-out from earlier
  // today) shows up as "Shift Open — Tap Resume" in the tray UI; the user
  // explicitly clicks Resume to opt back into tracking.
  await syncShiftState(token);
  if (!agentServicesStarted) return;
  if (activityStartMs !== null) {
    // syncShiftState set activityStartMs (recent shift) — propagate to the server
    pingHeartbeat();
  }

  // Re-sync every 60 seconds (same cadence as heartbeat) so missed socket
  // events (break-in, break-out, time-out) self-correct within one minute
  // rather than waiting the old 5-minute window.
  resyncIntervalId = setInterval(safeAsync(async () => {
    const currentToken = store.get("crm_token") as string | undefined;
    if (currentToken) await syncShiftState(currentToken);
    if (currentToken && agentState.user?.idleVideoProofEnabled) {
      flushIdleRecordingQueue(API_URL, currentToken).catch(() => {});
    }
  }, 'resync-shift-state'), 60 * 1000);

  // Re-fetch department-level flags (idleVideoProofEnabled, mainMonitorOnly,
  // idleDetectionExempt, screenshotsRequired) from /api/crm/me periodically — these were
  // previously only ever captured once, at the moment of a fresh browser-pushed login
  // (handleTrayAuth). A plain app restart reloads the SAME stale cached user object from
  // electron-store rather than re-fetching, so an admin toggling a department setting
  // mid-session (or between sessions, without the affected employee doing a genuine fresh web
  // login) saw the change silently never take effect — e.g. idleVideoProofEnabled staying
  // false forever, with every video-recording gate quietly no-op'ing and no diagnostic to
  // explain why. Run once shortly after startup (not just on the first 5-min tick) so a
  // recently-flipped toggle self-heals quickly, then keep re-checking periodically.
  const refreshDepartmentFlags = async (): Promise<void> => {
    if (getAuthMode() !== "crm") return;
    const currentToken = store.get("crm_token") as string | undefined;
    if (!currentToken) return;
    try {
      const { data } = await axios.get(`${API_URL}/api/crm/me`, {
        headers: { Authorization: `Bearer ${currentToken}` },
        params: { platform: process.platform },
        timeout: 10_000,
      });
      const fresh: User = data?.data || data;
      if (!fresh?.fullName) return;

      agentState.user = { ...agentState.user, ...fresh } as User;
      store.set("user", agentState.user);
      if (fresh.trayDeviceAuthEnabled) authCoordinator.ensureRegistered(currentToken).catch(() => {});

      setMainMonitorOnly(!!fresh.mainMonitorOnly);
      setIdleDetectionExempt(!!fresh.idleDetectionExempt);
      setSkipCaptures(!!fresh.screenshotExempt || fresh.screenshotsRequired === false);
      broadcastState();
    } catch {
      // Best-effort — keep whatever flags are already cached; next tick retries.
    }
  };
  setTimeout(safeAsync(refreshDepartmentFlags, 'department-flags-refresh-initial'), 30_000);
  departmentFlagsRefreshIntervalId = setInterval(safeAsync(refreshDepartmentFlags, 'department-flags-refresh'), 5 * 60 * 1000);

  if (authMode === "crm") {
    startDesktopLocation({
      apiUrl: API_URL,
      platform: process.platform,
      getToken: getStoredToken,
      getState: () => ({
        authMode: getAuthMode(),
        isAuthenticated: agentState.isAuthenticated,
        sessionExpired: agentState.sessionExpired,
        isOnShift: agentState.isOnShift,
        isOnBreak: agentState.isOnBreak,
        enabled: !!agentState.user?.desktopLocationEnabled,
      }),
      getInputAgeSec: () => powerMonitor.getSystemIdleTime(),
      onAuthRejected: (rejectedToken) => { reportAuthRejected(rejectedToken).catch(() => {}); },
      onDiagnostic: (event, message, meta) => { reportDiagnostic(event, message, meta); },
    });
  }
};

const stopAgentServices = () => {
  if (sessionCheckIntervalId) {
    clearInterval(sessionCheckIntervalId);
    sessionCheckIntervalId = null;
  }
  if (breakNotifyIntervalId) {
    clearInterval(breakNotifyIntervalId);
    breakNotifyIntervalId = null;
  }
  if (resyncIntervalId) {
    clearInterval(resyncIntervalId);
    resyncIntervalId = null;
  }
  if (departmentFlagsRefreshIntervalId) {
    clearInterval(departmentFlagsRefreshIntervalId);
    departmentFlagsRefreshIntervalId = null;
  }
  if (autoClockoutCheckIntervalId) {
    clearInterval(autoClockoutCheckIntervalId);
    autoClockoutCheckIntervalId = null;
  }
  if (activityCheckpointIntervalId) {
    clearInterval(activityCheckpointIntervalId);
    activityCheckpointIntervalId = null;
  }
  if (screenRecordingCheckIntervalId) {
    clearInterval(screenRecordingCheckIntervalId);
    screenRecordingCheckIntervalId = null;
  }
  breakExceededNotified = false;
  autoClockoutTriggeredForThisIdleStretch = false;
  agentServicesStarted = false;
  stopIdleMonitor();
  stopHeartbeat();
  stopScreenshots();
  disconnectSocket();
  stopDesktopLocation();
  destroyIdleRecorderWindow();
};

/* ─────────────────────────────────────────────────────────────────
   Auth handlers
   Sign-in happens on the dashboard in the browser — it silently hands a
   token to startLocalAuthServer() / handleTrayAuth() below. There is no
   manual login form in this app anymore.
───────────────────────────────────────────────────────────────── */
const handleLogout = async () => {
  resetSessionState(false);
  authCoordinator.signOut();
  showStatusWindow();
};

/* ─────────────────────────────────────────────────────────────────
   IPC handlers
───────────────────────────────────────────────────────────────── */
ipcMain.handle('auth:logout', handleLogout);

ipcMain.handle('status:get', () => agentState);

ipcMain.handle('app:open-crm', () => shell.openExternal(CRM_URL));
ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:open-screen-recording-settings', () => openScreenRecordingSettings());

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

// Actually continues the original, still-open time-in (deletes the auto-close time-out
// server-side) — previously the tray's "Yes, Resume Shift" button had no way to call this at
// all and fell back to a plain new time-in exactly like "No, Start a New Shift", so choosing
// "Yes" silently never resumed anything despite its label.
ipcMain.handle('shift:resume', async () => {
  const token = store.get('crm_token') as string | undefined;
  if (!token) return { success: false, error: 'Not authenticated' };
  try {
    await axios.post(`${API_URL}${getResumeShiftActionUrl()}`, {}, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15_000,
    });
    await syncShiftState(token);
    return { success: true };
  } catch (err: any) {
    if (isAuthRejection(err)) reportAuthRejected(token).catch(() => {});
    return { success: false, error: describeApiError(err, 'Failed to resume shift') };
  }
});

const performClockAction = async (type: string, note?: string): Promise<{ success: boolean; error?: string }> => {
  const token = store.get('crm_token') as string | undefined;
  if (!token) return { success: false, error: 'Not authenticated' };
  try {
    // Capture a screenshot before ending shift (CRM mode only — main mode skips screenshots).
    // Reflect the real idle state instead of the function's idle-only default, otherwise
    // every end-shift screenshot got mislabeled "idle" even when the user was active.
    if (type === 'time-out' && getAuthMode() === 'crm') {
      captureAndUploadOnce(API_URL, token, agentState.isIdle).catch(() => {});
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
    if (isAuthRejection(err)) reportAuthRejected(token).catch(() => {});
    const msg = describeApiError(err, 'Action failed');

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

ipcMain.handle('app:download-update', () => openUpdateDownload());
ipcMain.handle('app:quit', () => { app.quit(); });
ipcMain.handle('device:sign-in', () => authCoordinator.signInWithDevice({ userInitiated: true }));

/* ─────────────────────────────────────────────────────────────────
   Auth via token — shared by protocol URL and local HTTP server
───────────────────────────────────────────────────────────────── */
const authenticateWithToken = async (token: string): Promise<boolean> => {
  if (!token) return false;
  const storedToken = getStoredToken();
  if (agentState.isAuthenticated && (storedToken === token || isStaleSameUserToken(storedToken, token))) return true;

  const wasAuthenticated = agentState.isAuthenticated;
  const trackedUsername = agentState.user?.username;
  let user: User | null = null;
  let authMode: 'crm' | 'main' = 'crm';

  // Try CRM auth first
  try {
    const { data } = await axios.get(`${API_URL}/api/crm/me`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { platform: process.platform },
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

  // A different browser tab logged into a different account and auto-pushed its token to
  // this tray (TrayAutoConnect runs on every page load, for any account) — while a shift is
  // actively open, reject the handoff instead of silently switching identity mid-shift. This
  // was the root cause of several "sudden auto clock-out despite being active" reports: the
  // hijacked user's heartbeats went out under the new identity, so their real shift went
  // silent and got auto-closed hours later by the stale-heartbeat scheduler.
  if (wasAuthenticated && agentState.isOnShift && trackedUsername && trackedUsername !== user.username) {
    reportDiagnostic('tray_auth_rejected_different_user', 'Rejected auth handoff to a different user while on shift', {
      trackedUsername, incomingUsername: user.username,
    });
    return false;
  }

  agentState.isAuthenticated = true;
  agentState.sessionExpired = false;
  agentState.connection = null;
  agentState.user = user;
  agentState.isAgentOnline = true;
  setMainMonitorOnly(!!user.mainMonitorOnly);
  setIdleDetectionExempt(!!user.idleDetectionExempt);
  if (authMode === 'crm') {
    setSkipCaptures(!!user.screenshotExempt || user.screenshotsRequired === false);
  }
  store.set('crm_token', token);
  store.set('auth_mode', authMode);
  store.set('user', user);
  updateHeartbeatToken(token); // keep heartbeat JWT in sync when page sends a refreshed token
  updateScreenshotToken(token); // same — screenshot uploads used to silently go stale at the 12h JWT expiry
  // startAgentServices (and its connectSocket call) only runs on the FIRST
  // auth — a refreshed token arriving while already authenticated used to
  // never reach the socket, leaving it running on the original (eventually
  // stale) token until the app restarted.
  if (wasAuthenticated) {
    updateSocketToken(token);
    pingHeartbeat();
    syncShiftState(token).catch(() => {});
    flushQueue(API_URL, token).catch(() => {});
  } else {
    startAgentServices(token);
  }
  updateTrayIcon();
  tray?.setContextMenu(buildTrayMenu());
  broadcastState();
  scheduleSessionCheck(0);
  if (authMode === 'crm' && user.trayDeviceAuthEnabled) authCoordinator.ensureRegistered(token).catch(() => {});
  return true;
};

let trayAuthQueue: Promise<unknown> = Promise.resolve();

const handleTrayAuth = (token: string): Promise<boolean> => {
  const run = trayAuthQueue.then(
    () => authenticateWithToken(token),
    () => authenticateWithToken(token),
  );
  trayAuthQueue = run.catch(() => undefined);
  return run;
};

/* ─────────────────────────────────────────────────────────────────
   Local HTTP auth server — CRM web POSTs to this silently,
   zero browser dialog, tray auto-logs in when already running.
   Port 18642 — localhost only, no firewall exposure.
───────────────────────────────────────────────────────────────── */
const TRAY_AUTH_PORT = 18642;

const startLocalAuthServer = () => {
  const allowedOrigins = buildAllowedOrigins({
    crmUrl: CRM_URL,
    extra: process.env.TRAY_ALLOWED_ORIGINS,
    isPackaged: app.isPackaged,
  });
  const server = http.createServer((req, res) => {
    const allowedOrigin = matchOrigin(req.headers.origin, allowedOrigins);
    if (!allowedOrigin) { res.writeHead(403); res.end(); return; }
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
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
        const { token, bootstrapCode } = JSON.parse(body) as { token: string; bootstrapCode?: string };
        const ok = typeof bootstrapCode === 'string' && bootstrapCode
          ? await authCoordinator.handleBootstrap(bootstrapCode, { requireConfirm: false })
          : authCoordinator.isSignedOutByUser()
            ? false
            : await handleTrayAuth(token);
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

const PROTOCOL_PREFIX = 'actionauto://';

let startupComplete = false;
const pendingProtocolUrls: string[] = [];

const findProtocolUrl = (argv: string[]): string | undefined => argv.find((a) => a.startsWith(PROTOCOL_PREFIX));

const handleProtocolUrl = async (url: string): Promise<boolean> => {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'wake') return await authCoordinator.handleWake();
    if (parsed.hostname === 'connect') {
      const code = parsed.searchParams.get('code');
      return code ? await authCoordinator.handleBootstrap(code, { requireConfirm: true }) : false;
    }
    if (parsed.hostname !== 'auth') return false;
    const token = parsed.searchParams.get('token');
    return token ? await handleTrayAuth(token) : false;
  } catch {
    return false;
  }
};

const routeProtocolUrl = (url: string): void => {
  if (!startupComplete) {
    pendingProtocolUrls.push(url);
    return;
  }
  handleProtocolUrl(url).catch(() => {});
};

app.on('second-instance', (_event, argv) => {
  const url = findProtocolUrl(argv);
  if (url) routeProtocolUrl(url);
  else if (startupComplete) showStatusWindow();
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  routeProtocolUrl(url);
});

const AUTO_LAUNCH_CLEANUP_KEY = 'autoLaunchCleanupDone';

const runAutoLaunchCleanupOnce = async (): Promise<void> => {
  if (store.get(AUTO_LAUNCH_CLEANUP_KEY) === true) return;
  try { app.setLoginItemSettings({ openAtLogin: false }); } catch {}
  if (process.platform === 'win32') {
    try {
      for (const item of app.getLoginItemSettings().launchItems ?? []) {
        app.setLoginItemSettings({ openAtLogin: false, path: item.path, args: item.args, name: item.name });
      }
    } catch {}
  }
  try { await autoLauncher.disable(); } catch {}
  store.set(AUTO_LAUNCH_CLEANUP_KEY, true);
};

/* ─────────────────────────────────────────────────────────────────
   App ready
───────────────────────────────────────────────────────────────── */
app.whenReady().then(async () => {
  if (!gotLock) return;
  // Tray-only app — no dock icon on macOS
  if (process.platform === 'darwin') app.dock?.hide();
  runAutoLaunchCleanupOnce().catch(() => {});
  registerIdleRecordingIpcHandlers();
  startLocalAuthServer();

  app.on('render-process-gone', (_e, wc, details) => {
    reportDiagnostic('render_process_gone', details.reason, { exitCode: details.exitCode, platform: process.platform });
    if (statusWindow && !statusWindow.isDestroyed() && wc === statusWindow.webContents) {
      statusWindow.destroy();
      statusWindow = null;
      statusWindowLoadPromise = null;
      createStatusWindow();
    }
  });
  app.on('child-process-gone', (_e, details) => {
    reportDiagnostic('child_process_gone', `${details.type}: ${details.reason}`, { exitCode: details.exitCode, platform: process.platform });
  });

  let lastWatchdogTickAt = Date.now();
  const WATCHDOG_INTERVAL_MS = 5_000;
  const WATCHDOG_STALL_THRESHOLD_MS = 3_000;
  setInterval(() => {
    const now = Date.now();
    const blockedMs = now - lastWatchdogTickAt - WATCHDOG_INTERVAL_MS;
    lastWatchdogTickAt = now;
    if (blockedMs > WATCHDOG_STALL_THRESHOLD_MS) {
      reportDiagnostic('main_thread_stall', 'Main event loop was blocked', { blockedMs: Math.round(blockedMs), platform: process.platform });
    }
  }, WATCHDOG_INTERVAL_MS);

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
  powerMonitor.on('suspend', pauseDesktopLocation);
  powerMonitor.on('resume', resumeDesktopLocation);

  // Suspend already checkpoints and rolls activityStartMs forward to the
  // moment sleep began (see handleSystemSuspendOrShutdown above) — but nothing
  // handled the OTHER end of that gap. Tracking relied entirely on the idle
  // monitor's own next tick to notice the sleep-induced gap and truncate it
  // correctly via getSystemIdleTime(). That reading has already been found
  // (this week's "one Mac updates, another doesn't" + recurring "false idle"
  // reports) to be inconsistent across sleep/wake on some hardware/OS
  // combinations — sometimes it comes back low right after waking instead of
  // reflecting the real sleep duration. When that happens, isIdle never flips,
  // the idle-transition truncation in startIdleMonitor's callback never runs,
  // and the next unrelated event (10-min periodic checkpoint, a break, etc.)
  // commits straight from the pre-sleep activityStartMs to Date.now() —
  // silently crediting the entire sleep duration as active work time. Forcing
  // idle state on resume, the same way a real "went idle" transition does,
  // closes that gap regardless of what the idle-timer reports afterward: real
  // input arriving post-wake still flips back to active normally (same
  // !isIdle && wasIdle branch below), it just can no longer skip that check.
  let lastResumeForcedIdleAt = 0;
  powerMonitor.on('resume', () => {
    ensureTray();
    scheduleSessionCheck();
    if (agentState.isOnShift && !agentState.isOnBreak && activityStartMs !== null) {
      activityStartMs = null;
      agentState.activityStartMs = null;
      agentState.isIdle = true;
      forceIdleState(true);
      lastResumeForcedIdleAt = Date.now();
      stopIdleVideoIfRecording('partial');
      stopScreenshots();
      agentState.nextScreenshotIn = null;
      reportDiagnostic('resume_from_suspend', 'System resumed from sleep — forced idle pending real input', {
        platform: process.platform,
      });
      broadcastState();
    }
  });

  const handleUserPresent = (source: string) => {
    if (Date.now() - lastResumeForcedIdleAt < 3000) return;
    if (!agentState.isOnShift || agentState.isOnBreak) return;
    if (!agentState.isIdle) return;
    agentState.isIdle = false;
    forceIdleState(false);
    stopIdleVideoIfRecording('partial');
    activityStartMs = Date.now();
    agentState.activityStartMs = activityStartMs;
    const currentToken = store.get('crm_token') as string | undefined;
    if (currentToken && agentState.isAuthenticated) {
      startScreenshots(API_URL, currentToken);
      agentState.nextScreenshotIn = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    }
    pingHeartbeat();
    reportDiagnostic('user_present_cleared_idle', `Cleared stale idle flag on ${source}`, { platform: process.platform });
    broadcastState();
  };
  powerMonitor.on('unlock-screen', () => {
    scheduleSessionCheck();
    handleUserPresent('unlock-screen');
  });
  if (process.platform === 'darwin') {
    powerMonitor.on('user-did-become-active', () => handleUserPresent('user-did-become-active'));
  }

  // macOS can silently tear down the NSStatusItem behind a Tray instance during a display/session
  // reconfiguration (e.g. a remote-desktop session like TeamViewer attaching/detaching triggers the
  // same kind of event as plugging/unplugging a monitor) — the icon vanishes for good with nothing
  // recreating it, even though the rest of the app (screenshots, clock) keeps running fine. Wrapped
  // so display-change listeners below can rebuild it instead of leaving the user with no icon at all.
  const ensureTray = () => {
    if (tray && !tray.isDestroyed()) return;
    tray = new Tray(getTrayIcon());
    tray.setToolTip('Suprah AI - Timeproof Clock');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => {
      if (statusWindow?.isVisible()) statusWindow.hide();
      else showStatusWindow();
    });
  };
  ensureTray();
  screen.on('display-added', ensureTray);
  screen.on('display-removed', ensureTray);

  createStatusWindow();

  try { store.delete('pendingUpdateRelaunchAt'); } catch {}

  const launchUrl = findProtocolUrl(process.argv);
  const launchAuthenticated = launchUrl ? await handleProtocolUrl(launchUrl) : false;
  if (!launchAuthenticated) await restoreSavedSession();
  startupComplete = true;
  for (const url of pendingProtocolUrls.splice(0)) await handleProtocolUrl(url);

  if (app.isPackaged) {
    setTimeout(() => { runUpdateCheck().catch(() => {}); }, UPDATE_FIRST_CHECK_DELAY_MS);
    setInterval(() => { runUpdateCheck().catch(() => {}); }, UPDATE_CHECK_INTERVAL_MS);
  }
});

// Keep app running in tray even when all windows are closed
app.on('window-all-closed', () => { /* intentional noop */ });
