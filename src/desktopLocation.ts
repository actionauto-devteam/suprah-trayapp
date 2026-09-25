import { BrowserWindow, session } from 'electron';
import { createServer } from 'http';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  DESKTOP_LOCATION_FAILURE_BACKOFF_MS,
  DESKTOP_LOCATION_IDLE_POLL_MS,
  DESKTOP_LOCATION_INTERVAL_MS,
  DESKTOP_LOCATION_RESUME_DELAY_MS,
  buildDesktopPingPayload,
  canRunDesktopLocation,
  delayAfterFixFailure,
  nextDelayAfterPost,
  parseFixResult,
  postDesktopPing,
  shouldReportDiagnostic,
} from './desktopLocationCore';
import type { DesktopRunState, FixResult } from './desktopLocationCore';

export interface DesktopLocationDeps {
  apiUrl: string;
  platform: string;
  getToken: () => string | undefined;
  getState: () => DesktopRunState;
  getInputAgeSec: () => number;
  onAuthRejected: (rejectedToken: string) => void;
  onDiagnostic: (event: string, message: string, meta?: Record<string, unknown>) => void;
  intervalMs?: number;
  startDelayMs?: number;
}

const PARTITION = 'desktop-location';
const PAGE_HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
const FIX_SCRIPT = `new Promise((resolve) => {
  if (!navigator.geolocation) { resolve({ ok: false, code: 0, message: 'geolocation unsupported' }); return; }
  const timer = setTimeout(() => resolve({ ok: false, code: 3, message: 'timed out' }), 25000);
  navigator.geolocation.getCurrentPosition(
    (p) => { clearTimeout(timer); resolve({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy }); },
    (e) => { clearTimeout(timer); resolve({ ok: false, code: e.code, message: e.message }); },
    { enableHighAccuracy: false, timeout: 20000, maximumAge: 30000 }
  );
})`;

let deps: DesktopLocationDeps | null = null;
let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let tickInFlight = false;
let win: BrowserWindow | null = null;
let server: Server | null = null;
let serverPort = 0;
const diagnosticAt = new Map<string, number>();

const ensureServer = (): Promise<number> =>
  new Promise((resolve, reject) => {
    if (server && serverPort) {
      resolve(serverPort);
      return;
    }
    const created = createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(PAGE_HTML);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    created.once('error', reject);
    created.listen(0, '127.0.0.1', () => {
      created.removeListener('error', reject);
      created.on('error', () => {});
      server = created;
      serverPort = (created.address() as AddressInfo).port;
      resolve(serverPort);
    });
  });

const closeServer = (): void => {
  if (!server) return;
  server.closeAllConnections();
  server.close();
  server = null;
  serverPort = 0;
};

const destroyWindow = (): void => {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
};

const ensureWindow = async (): Promise<BrowserWindow> => {
  if (win && !win.isDestroyed()) return win;
  const port = await ensureServer();
  const geoSession = session.fromPartition(PARTITION);
  geoSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'geolocation'));
  geoSession.setPermissionCheckHandler((_wc, permission) => permission === 'geolocation');
  const created = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    skipTaskbar: true,
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  created.webContents.on('will-navigate', (event) => event.preventDefault());
  created.on('closed', () => {
    if (win === created) win = null;
  });
  await created.loadURL(`http://127.0.0.1:${port}/`);
  win = created;
  return created;
};

const requestFix = async (): Promise<FixResult> => {
  const target = await ensureWindow();
  const raw: unknown = await target.webContents.executeJavaScript(FIX_SCRIPT);
  return parseFixResult(raw);
};

const reportOnce = (key: string, event: string, message: string, meta: Record<string, unknown>): void => {
  const now = Date.now();
  if (!shouldReportDiagnostic(diagnosticAt.get(key), now)) return;
  diagnosticAt.set(key, now);
  deps?.onDiagnostic(event, message, meta);
};

const schedule = (delayMs: number): void => {
  if (!running) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    tick().catch(() => {});
  }, delayMs);
};

const tick = async (): Promise<void> => {
  timer = null;
  if (!running || !deps || tickInFlight) return;
  tickInFlight = true;
  let delayMs = deps.intervalMs ?? DESKTOP_LOCATION_INTERVAL_MS;
  try {
    if (!canRunDesktopLocation(deps.getState())) {
      destroyWindow();
      delayMs = DESKTOP_LOCATION_IDLE_POLL_MS;
    } else {
      const token = deps.getToken();
      if (!token) {
        delayMs = DESKTOP_LOCATION_IDLE_POLL_MS;
      } else {
        const result = await requestFix();
        if (!running || !deps) return;
        if (!result.ok) {
          delayMs = delayAfterFixFailure(result.code);
          reportOnce(
            `fix:${result.code}`,
            'desktop_location_unavailable',
            'Desktop location fix failed',
            { code: result.code, message: result.message, platform: deps.platform },
          );
        } else {
          const payload = buildDesktopPingPayload(result.fix, deps.getInputAgeSec(), deps.platform);
          const latestToken = deps.getToken() ?? token;
          const outcome = await postDesktopPing(deps.apiUrl, latestToken, payload);
          if (!running || !deps) return;
          if (outcome.kind === 'authRejected') deps.onAuthRejected(latestToken);
          delayMs = nextDelayAfterPost(outcome, deps.intervalMs);
        }
      }
    }
  } catch {
    destroyWindow();
    delayMs = DESKTOP_LOCATION_FAILURE_BACKOFF_MS;
  } finally {
    tickInFlight = false;
    schedule(delayMs);
  }
};

export const startDesktopLocation = (nextDeps: DesktopLocationDeps): void => {
  deps = nextDeps;
  if (running) return;
  running = true;
  schedule(nextDeps.startDelayMs ?? DESKTOP_LOCATION_IDLE_POLL_MS);
};

export const stopDesktopLocation = (): void => {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  destroyWindow();
  closeServer();
  deps = null;
  diagnosticAt.clear();
};

export const pauseDesktopLocation = (): void => {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
};

export const resumeDesktopLocation = (): void => {
  if (running) schedule(DESKTOP_LOCATION_RESUME_DELAY_MS);
};
