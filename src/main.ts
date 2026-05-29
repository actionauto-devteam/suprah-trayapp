import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, screen, Notification } from 'electron';
app.setName('Action Auto CRM Tray-App');
import path from 'path';
import http from 'http';
import axios from 'axios';
import dotenv from 'dotenv';
import { autoUpdater } from 'electron-updater';

// Check for updates silently in the background; install automatically on quit
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null;

autoUpdater.on('update-downloaded', () => {
  if (Notification.isSupported()) {
    new Notification({
      title: 'Update ready',
      body: 'A new version of Action Auto Tray has been downloaded and will install automatically when you quit.',
      silent: true,
    }).show();
  }
});
// In a packaged build, .env lives in extraResources (process.resourcesPath).
// In dev, it lives at the project root (one level above dist/).
const envPath = app.isPackaged
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '..', '.env');
dotenv.config({ path: envPath });
import { connectSocket, disconnectSocket } from './socket';
import { startIdleMonitor, stopIdleMonitor } from './idle';
import { startHeartbeat, stopHeartbeat, pingHeartbeat } from './heartbeat';
import { startScreenshots, stopScreenshots, captureAndUploadOnce } from './screenshot';
import { flushQueue } from './offline-queue';

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
}

let tray: Tray | null = null;
let loginWindow: BrowserWindow | null = null;
let statusWindow: BrowserWindow | null = null;

let breakNotifyIntervalId: ReturnType<typeof setInterval> | null = null;
let resyncIntervalId: ReturnType<typeof setInterval> | null = null;
let breakExceededNotified = false;

// Activity-based time tracking (idle-aware)
let activityStartMs: number | null = null;  // when current active period began (local clock)
let todayTotalActiveMs: number = 0;         // sum of completed active interval durations

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
};

/* ─────────────────────────────────────────────────────────────────
   State broadcast helpers
───────────────────────────────────────────────────────────────── */
const broadcastState = () => {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.webContents.send('status:update', agentState);
  }
  updateTrayIcon();
  tray?.setContextMenu(buildTrayMenu());
};

/* ─────────────────────────────────────────────────────────────────
   Tray icon helpers
───────────────────────────────────────────────────────────────── */
const getTrayIcon = () => {
  const iconName = agentState.isAgentOnline
    ? agentState.isOnShift
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

  const tooltip = agentState.isAuthenticated
    ? agentState.isOnShift
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
    items.push({ label: agentState.user.fullName, enabled: false });
    items.push({
      label: agentState.isOnShift
        ? agentState.isIdle ? '⚪ Idle' : '🟢 On Shift'
        : agentState.isOnBreak ? '☕ On Break' : '⚫ Not Clocked In',
      enabled: false,
    });
    items.push({ type: 'separator' });
    items.push({ label: 'Open CRM', click: () => shell.openExternal(CRM_URL) });
    items.push({ type: 'separator' });
    items.push({ label: 'Sign Out', click: handleLogout });
  } else {
    items.push({ label: 'Sign In', click: showLoginWindow });
  }

  items.push({ type: 'separator' });
  items.push({ label: 'Quit', click: () => app.quit() });

  return Menu.buildFromTemplate(items);
};

/* ─────────────────────────────────────────────────────────────────
   Windows
───────────────────────────────────────────────────────────────── */
const createLoginWindow = () => {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 380,
    height: 480,
    resizable: false,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    center: true,
    title: 'Action Auto — Sign In',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loginWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'login.html'));
  loginWindow.on('closed', () => { loginWindow = null; });
};

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

const showLoginWindow = () => {
  if (!loginWindow || loginWindow.isDestroyed()) createLoginWindow();
  else loginWindow.show();
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
      const { data } = await axios.get(`${API_URL}/api/crm/timeproof/shift-state`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10_000,
      });
      const s = data?.data;
      if (!s) return;
      // If the backend says the user is on shift but that shift started on a previous
      // day (isShiftFromToday=false), treat them as off-shift in the tray. Opening the
      // app should NOT auto-start the timer for a forgotten clock-out from days ago.
      const effectivelyOnShift = s.isOnShift && (s.isShiftFromToday !== false);
      agentState.isOnShift              = effectivelyOnShift;
      agentState.isOnBreak              = effectivelyOnShift ? s.isOnBreak : false;
      agentState.shiftStartedAt         = effectivelyOnShift ? (s.shiftStartedAt ?? null) : null;
      agentState.breakStartedAt         = effectivelyOnShift ? (s.breakStartedAt ?? null) : null;
      agentState.totalBreakSeconds      = effectivelyOnShift ? (s.totalBreakSeconds ?? 0) : 0;
      agentState.todayTotalWorkedSeconds = s.todayTotalWorkedSeconds ?? 0;
      // Activity-based tracking: pull the authoritative completed-interval total from the server.
      // We do NOT restore activityStartMs from currentIntervalStartAt because that value could
      // be stale (written before a restart) and would inflate the timer with offline time.
      // The live interval start is managed locally and reset fresh on each app session.
      todayTotalActiveMs = (s.todayTotalActiveSeconds ?? 0) * 1000;
      agentState.todayTotalActiveMs = todayTotalActiveMs;
      agentState.activityStartMs = activityStartMs; // keep whatever is already set locally
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

const startAgentServices = async (token: string) => {
  const SCREENSHOT_INTERVAL_MS = 10 * 60 * 1000;
  const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 60 * 1000; // 10 hours — renew before 12h expiry

  // Proactively renew token every 10 hours so the tray never goes stale
  tokenRefreshIntervalId = setInterval(async () => {
    const current = store.get('crm_token') as string | undefined;
    if (!current) return;
    const refreshed = await tryRefreshToken(current);
    if (!refreshed) {
      handleLogout();
    }
  }, TOKEN_REFRESH_INTERVAL_MS);

  startIdleMonitor(async (isIdle) => {
    const wasIdle = agentState.isIdle;
    agentState.isIdle = isIdle;

    // Activity tracking only applies while the user is clocked in and not on break
    const wasTracking = agentState.isOnShift && !agentState.isOnBreak;

    if (isIdle && !wasIdle) {
      // User just went idle — save the completed active interval if we were counting
      if (wasTracking && activityStartMs !== null) {
        const currentToken = store.get('crm_token') as string | undefined;
        const endAt = new Date();
        const durationMs = endAt.getTime() - activityStartMs;
        if (currentToken && durationMs >= 30_000) {
          try {
            await axios.post(
              `${API_URL}/api/crm/timeproof/activity-interval`,
              { startAt: new Date(activityStartMs).toISOString(), endAt: endAt.toISOString() },
              { headers: { Authorization: `Bearer ${currentToken}` }, timeout: 10_000 }
            );
            todayTotalActiveMs += durationMs;
            agentState.todayTotalActiveMs = todayTotalActiveMs;
          } catch { }
        }
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

  // Check every 30s if break has exceeded 1 hour — notify user once per break session
  breakExceededNotified = false;
  breakNotifyIntervalId = setInterval(() => {
    if (!agentState.isOnBreak || !agentState.breakStartedAt) {
      breakExceededNotified = false;
      return;
    }
    if (breakExceededNotified) return;
    const breakSecs = Math.floor((Date.now() - new Date(agentState.breakStartedAt).getTime()) / 1000);
    if (breakSecs >= 3600 && Notification.isSupported()) {
      breakExceededNotified = true;
      new Notification({
        title: 'Break time exceeded',
        body: 'You have exceeded your break time. Your admin has been notified.',
        silent: false,
      }).show();
    }
  }, 30_000);

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
      // "was counting" = clocked in and not on break and not idle
      const wasTracking = prevIsOnShift && !prevIsOnBreak && !agentState.isIdle;

      agentState = { ...agentState, ...partial };
      agentState.isAgentOnline = true;

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
              `${API_URL}/api/crm/timeproof/activity-interval`,
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
        // Clocked in or resumed from break (not idle) — start a new active interval
        activityStartMs = Date.now();
        agentState.activityStartMs = activityStartMs;
        const nextIn = Date.now() + SCREENSHOT_INTERVAL_MS;
        agentState.nextScreenshotIn = new Date(nextIn).toISOString();
        startScreenshots(API_URL, token);
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
  );

  // Sync state, then start activity tracking only if clocked in and not idle/break
  await syncShiftState(token);
  if (agentState.isOnShift && !agentState.isOnBreak && !agentState.isIdle) {
    if (activityStartMs === null) {
      activityStartMs = Date.now();
      agentState.activityStartMs = activityStartMs;
    }
    startScreenshots(API_URL, token);
    pingHeartbeat();
  }

  // Re-sync every 5 minutes so activity totals stay in sync with server
  resyncIntervalId = setInterval(() => {
    const currentToken = store.get('crm_token') as string | undefined;
    if (currentToken) syncShiftState(currentToken);
  }, 5 * 60 * 1000);
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
  breakExceededNotified = false;
  stopIdleMonitor();
  stopHeartbeat();
  stopScreenshots();
  disconnectSocket();
};

/* ─────────────────────────────────────────────────────────────────
   Auth handlers
───────────────────────────────────────────────────────────────── */
interface LoginResult {
  success: boolean;
  error?: string;
  user?: User;
  token?: string;
}

const handleLogin = async (username: string, password: string): Promise<LoginResult> => {
  try {
    const { data } = await axios.post(`${API_URL}/api/crm/login`, { username, password }, { timeout: 15_000 });
    if (data?.data?.token && data?.data?.user) {
      return { success: true, token: data.data.token, user: data.data.user };
    }
    return { success: false, error: data?.message || 'Login failed' };
  } catch (err: any) {
    const msg = err?.response?.data?.message || 'Could not connect to server';
    return { success: false, error: msg };
  }
};

const handleLogout = async () => {
  stopAgentServices();
  activityStartMs = null;
  todayTotalActiveMs = 0;
  store.delete('crm_token');
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
  };
  updateTrayIcon();
  tray?.setContextMenu(buildTrayMenu());
  statusWindow?.hide();
  showLoginWindow();
};

/* ─────────────────────────────────────────────────────────────────
   IPC handlers
───────────────────────────────────────────────────────────────── */
ipcMain.handle('auth:login', async (_e, { username, password }: { username: string; password: string }) => {
  const result = await handleLogin(username, password);
  if (result.success && result.user && result.token) {
    agentState.isAuthenticated = true;
    agentState.user = result.user;
    agentState.isAgentOnline = true;
    store.set('crm_token', result.token);
    store.set('user', result.user);
    loginWindow?.close();
    startAgentServices(result.token);
    broadcastState();
  }
  return result;
});

ipcMain.handle('auth:logout', handleLogout);

ipcMain.handle('remember:get', () => store.get('rememberedUsername') as string | undefined ?? null);
ipcMain.handle('remember:set', (_e, username: string | null) => {
  if (username) store.set('rememberedUsername', username);
  else store.delete('rememberedUsername');
});

ipcMain.handle('status:get', () => agentState);

ipcMain.handle('app:open-crm', () => shell.openExternal(CRM_URL));

ipcMain.handle('timeclock:action', async (_e, type: string, note?: string) => {
  const token = store.get('crm_token') as string | undefined;
  if (!token) return { success: false, error: 'Not authenticated' };
  try {
    // Capture a screenshot before ending shift as proof of the final screen state
    if (type === 'time-out') {
      captureAndUploadOnce(API_URL, token).catch(() => {});
    }
    await axios.post(`${API_URL}/api/crm/time-clock`, { type, ...(note && { note }) }, {
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
    const msg = err?.response?.data?.message || 'Action failed';
    return { success: false, error: msg };
  }
});

/* ─────────────────────────────────────────────────────────────────
   Auth via token — shared by protocol URL and local HTTP server
───────────────────────────────────────────────────────────────── */
const handleTrayAuth = async (token: string): Promise<boolean> => {
  if (!token) return false;
  // Same token already active — nothing to do
  if (agentState.isAuthenticated && store.get('crm_token') === token) return true;

  const wasAuthenticated = agentState.isAuthenticated;
  const { data } = await axios.get(`${API_URL}/api/crm/me`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10_000,
  });
  const user: User = data?.data || data;
  if (!user?.fullName) return false;

  agentState.isAuthenticated = true;
  agentState.user = user;
  agentState.isAgentOnline = true;
  store.set('crm_token', token);
  store.set('user', user);
  loginWindow?.close();
  if (!wasAuthenticated) startAgentServices(token);
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
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  try { autoLauncher.enable(); } catch { } // register with auto-launch as fallback
  startLocalAuthServer();

  tray = new Tray(getTrayIcon());
  tray.setToolTip('Action Auto Tray');
  tray.setContextMenu(buildTrayMenu());

  tray.on('click', () => {
    if (!agentState.isAuthenticated) {
      showLoginWindow();
    } else {
      if (statusWindow?.isVisible()) statusWindow.hide();
      else showStatusWindow();
    }
  });

  const savedToken = store.get('crm_token') as string | undefined;
  const savedUser = store.get('user');
  if (savedToken && savedUser) {
    agentState.isAuthenticated = true;
    agentState.user = savedUser as User;
    agentState.isAgentOnline = true;
    updateTrayIcon();
    tray.setContextMenu(buildTrayMenu());
    // Proactively refresh token on startup — use new token if successful, fall back to stored
    const activeToken = await tryRefreshToken(savedToken) ?? savedToken;
    startAgentServices(activeToken);
  } else {
    showLoginWindow();
  }

  createStatusWindow();

  // Check for updates 15s after startup so the app is fully initialized first
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, 15_000);
  }
});

// Keep app running in tray even when all windows are closed
app.on('window-all-closed', () => { /* intentional noop */ });
