import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, screen } from 'electron';
import path from 'path';
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
}

let tray: Tray | null = null;
let loginWindow: BrowserWindow | null = null;
let statusWindow: BrowserWindow | null = null;

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
    height: 360,
    x: width - 316,
    y: height - 376,
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
  }
};

/* ─────────────────────────────────────────────────────────────────
   Auth handlers (stubs — wired up in Phase 3 backend)
───────────────────────────────────────────────────────────────── */
interface LoginResult {
  success: boolean;
  error?: string;
  user?: User;
  token?: string;
}

const handleLogin = async (_email: string, _password: string): Promise<LoginResult> => {
  // TODO Phase 3 backend: POST /api/crm/auth/login
  return { success: false, error: 'Backend not connected yet' };
};

const handleLogout = async () => {
  store.delete('crm_token');
  store.delete('user');
  agentState = { ...agentState, isAuthenticated: false, user: null, isOnShift: false, isOnBreak: false };
  updateTrayIcon();
  tray?.setContextMenu(buildTrayMenu());
  statusWindow?.hide();
  showLoginWindow();
};

/* ─────────────────────────────────────────────────────────────────
   IPC handlers
───────────────────────────────────────────────────────────────── */
ipcMain.handle('auth:login', async (_e, { email, password }: { email: string; password: string }) => {
  const result = await handleLogin(email, password);
  if (result.success && result.user && result.token) {
    agentState.isAuthenticated = true;
    agentState.user = result.user;
    store.set('crm_token', result.token);
    store.set('user', result.user);
    loginWindow?.close();
    updateTrayIcon();
    tray?.setContextMenu(buildTrayMenu());
  }
  return result;
});

ipcMain.handle('auth:logout', handleLogout);

ipcMain.handle('status:get', () => agentState);

ipcMain.handle('app:open-crm', () => shell.openExternal(CRM_URL));

/* ─────────────────────────────────────────────────────────────────
   App ready
───────────────────────────────────────────────────────────────── */
app.whenReady().then(() => {
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });

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

  const savedToken = store.get('crm_token');
  const savedUser = store.get('user');
  if (savedToken && savedUser) {
    agentState.isAuthenticated = true;
    agentState.user = savedUser as User;
    updateTrayIcon();
    tray.setContextMenu(buildTrayMenu());
  } else {
    showLoginWindow();
  }

  createStatusWindow();
});

// Keep app running in tray even when all windows are closed
app.on('window-all-closed', () => { /* intentional noop */ });
