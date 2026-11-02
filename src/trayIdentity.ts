import axios from 'axios';
import crypto from 'crypto';

export const TRAY_ACTIVE_ELSEWHERE = 'TRAY_ACTIVE_ELSEWHERE';

const TRAY_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

let installed = false;
let standbyRejectedHandler: (() => void) | null = null;

export function getOrCreateTrayId(read: () => unknown, write: (id: string) => void): string {
  const existing = read();
  if (typeof existing === 'string' && TRAY_ID_PATTERN.test(existing)) return existing;
  const id = crypto.randomUUID();
  write(id);
  return id;
}

export function installTrayIdentity(trayId: string, apiUrl: string): void {
  if (installed) return;
  installed = true;
  axios.interceptors.request.use((config) => {
    const url = config.url ?? '';
    if (apiUrl && url.startsWith(apiUrl)) {
      config.headers.set('X-Tray-Id', trayId);
    }
    return config;
  });
}

export function isTrayStandbyRejection(err: unknown): boolean {
  const response = (err as { response?: { status?: number; data?: { code?: string } } })?.response;
  return response?.status === 409 && response?.data?.code === TRAY_ACTIVE_ELSEWHERE;
}

export function setStandbyRejectedHandler(handler: () => void): void {
  standbyRejectedHandler = handler;
}

export function notifyStandbyRejected(): void {
  standbyRejectedHandler?.();
}
