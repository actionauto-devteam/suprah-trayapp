import axios from 'axios';
import { isAuthRejection } from './session';

export const DESKTOP_LOCATION_INTERVAL_MS = 60_000;
export const DESKTOP_LOCATION_IDLE_POLL_MS = 15_000;
export const DESKTOP_LOCATION_FAILURE_BACKOFF_MS = 2 * 60_000;
export const DESKTOP_LOCATION_UNAVAILABLE_BACKOFF_MS = 5 * 60_000;
export const DESKTOP_LOCATION_DENIED_BACKOFF_MS = 30 * 60_000;
export const DESKTOP_LOCATION_RESUME_DELAY_MS = 15_000;
export const DESKTOP_LOCATION_DIAGNOSTIC_COOLDOWN_MS = 30 * 60_000;
const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60 * 60_000;
const DEFAULT_RETRY_SEC = 300;
const GEO_PERMISSION_DENIED = 1;

export interface DesktopFix {
  lat: number;
  lng: number;
  accuracyM: number | null;
}

export type FixResult =
  | { ok: true; fix: DesktopFix }
  | { ok: false; code: number; message: string };

export interface DesktopRunState {
  authMode: 'crm' | 'main';
  isAuthenticated: boolean;
  sessionExpired: boolean;
  isOnShift: boolean;
  isOnBreak: boolean;
  enabled: boolean;
}

export interface DesktopPingPayload {
  lat: number;
  lng: number;
  accuracyM?: number;
  inputAgeSec: number;
  platform: string;
}

export type DesktopPostOutcome =
  | { kind: 'accepted' }
  | { kind: 'rejected'; reason: string; retryAfterMs: number }
  | { kind: 'authRejected' }
  | { kind: 'failed' };

export const canRunDesktopLocation = (state: DesktopRunState): boolean =>
  state.authMode === 'crm'
  && state.isAuthenticated
  && !state.sessionExpired
  && state.isOnShift
  && !state.isOnBreak
  && state.enabled;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const parseFixResult = (raw: unknown): FixResult => {
  if (raw === null || typeof raw !== 'object') return { ok: false, code: 0, message: 'no result' };
  const value = raw as Record<string, unknown>;
  if (value.ok === true && finite(value.lat) && finite(value.lng)
    && value.lat >= -90 && value.lat <= 90 && value.lng >= -180 && value.lng <= 180) {
    const accuracyM = finite(value.accuracyM) && value.accuracyM >= 0 ? value.accuracyM : null;
    return { ok: true, fix: { lat: value.lat, lng: value.lng, accuracyM } };
  }
  return {
    ok: false,
    code: finite(value.code) ? value.code : 0,
    message: typeof value.message === 'string' ? value.message.slice(0, 200) : 'invalid fix',
  };
};

export const delayAfterFixFailure = (code: number): number =>
  code === GEO_PERMISSION_DENIED ? DESKTOP_LOCATION_DENIED_BACKOFF_MS : DESKTOP_LOCATION_UNAVAILABLE_BACKOFF_MS;

export const buildDesktopPingPayload = (
  fix: DesktopFix,
  inputAgeSec: number,
  platform: string,
): DesktopPingPayload => ({
  lat: fix.lat,
  lng: fix.lng,
  ...(fix.accuracyM !== null && { accuracyM: fix.accuracyM }),
  inputAgeSec: finite(inputAgeSec) && inputAgeSec >= 0 ? Math.round(inputAgeSec) : 0,
  platform,
});

export const postDesktopPing = async (
  apiUrl: string,
  token: string,
  payload: DesktopPingPayload,
  timeoutMs = 10_000,
): Promise<DesktopPostOutcome> => {
  try {
    const { data } = await axios.post(`${apiUrl}/api/locator/desktop-ping`, payload, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: timeoutMs,
    });
    const body = (data?.data ?? data) as Record<string, unknown> | null;
    if (body?.accepted === true) return { kind: 'accepted' };
    if (body?.accepted === false) {
      const retrySec = finite(body.retryAfterSec) && body.retryAfterSec > 0 ? body.retryAfterSec : DEFAULT_RETRY_SEC;
      return {
        kind: 'rejected',
        reason: typeof body.reason === 'string' ? body.reason : 'unknown',
        retryAfterMs: Math.min(Math.max(retrySec * 1000, MIN_RETRY_MS), MAX_RETRY_MS),
      };
    }
    return { kind: 'failed' };
  } catch (err) {
    return isAuthRejection(err) ? { kind: 'authRejected' } : { kind: 'failed' };
  }
};

export const nextDelayAfterPost = (outcome: DesktopPostOutcome, intervalMs = DESKTOP_LOCATION_INTERVAL_MS): number => {
  if (outcome.kind === 'accepted') return intervalMs;
  if (outcome.kind === 'rejected') return outcome.retryAfterMs;
  if (outcome.kind === 'authRejected') return DESKTOP_LOCATION_UNAVAILABLE_BACKOFF_MS;
  return DESKTOP_LOCATION_FAILURE_BACKOFF_MS;
};

export const shouldReportDiagnostic = (
  lastReportedAt: number | undefined,
  nowMs: number,
  cooldownMs = DESKTOP_LOCATION_DIAGNOSTIC_COOLDOWN_MS,
): boolean => lastReportedAt === undefined || nowMs - lastReportedAt >= cooldownMs;
