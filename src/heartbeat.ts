import axios from 'axios';
import { app } from 'electron';
import { getIsIdle } from './idle';
import { getScreenRecordingGranted } from './permissions';
import { reportDiagnostic } from './screenshot';

const INTERVAL_MS = 60_000;
const PING_FAIL_REPORT_COOLDOWN_MS = 10 * 60 * 1000;

type ShiftState = { isOnBreak: boolean; breakDurationSeconds: number; isOnShift: boolean; currentIntervalStartAt: string | null };

let intervalId: ReturnType<typeof setInterval> | null = null;
let _ping: (() => Promise<void>) | null = null;
let heartbeatPath = '/api/crm/timeproof/heartbeat';
let _activeToken = '';
let lastPingFailReportedAt = 0;
let _onScreenshotsRequired: ((required: boolean) => void) | null = null;

export function setOnScreenshotsRequired(cb: (required: boolean) => void): void {
  _onScreenshotsRequired = cb;
}

export function setHeartbeatPath(path: string): void {
  heartbeatPath = path;
}

export function updateHeartbeatToken(newToken: string): void {
  _activeToken = newToken;
}

export function startHeartbeat(apiUrl: string, token: string, getShiftState: () => ShiftState): void {
  if (intervalId) return;
  _activeToken = token;

  _ping = async () => {
    try {
      const { isOnBreak, breakDurationSeconds, isOnShift, currentIntervalStartAt } = getShiftState();
      const isIdle = isOnBreak || !isOnShift ? false : getIsIdle();
      const res = await axios.post(
        `${apiUrl}${heartbeatPath}`,
        {
          isIdle, platform: process.platform, isOnBreak, breakDurationSeconds, isOnShift, currentIntervalStartAt,
          screenRecordingGranted: getScreenRecordingGranted(),
          appVersion: app.getVersion(),
        },
        { headers: { Authorization: `Bearer ${_activeToken}` }, timeout: 10_000 }
      );
      const screenshotsRequired = (res.data?.data ?? res.data)?.screenshotsRequired;
      if (typeof screenshotsRequired === 'boolean') _onScreenshotsRequired?.(screenshotsRequired);
    } catch (err) {
      const now = Date.now();
      if (now - lastPingFailReportedAt > PING_FAIL_REPORT_COOLDOWN_MS) {
        lastPingFailReportedAt = now;
        const axiosErr = err as { response?: { status?: number }; message?: string };
        reportDiagnostic('heartbeat_ping_failed', 'Heartbeat POST failed', {
          status: axiosErr?.response?.status ?? null,
          message: axiosErr?.message ?? String(err),
        });
      }
    }
  };

  _ping(); // immediate first ping
  intervalId = setInterval(_ping, INTERVAL_MS);
}

/** Fire an immediate out-of-band heartbeat — call when shift/break state changes. */
export function pingHeartbeat(): void {
  _ping?.();
}

export function stopHeartbeat(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  _ping = null;
  _activeToken = '';
  _onScreenshotsRequired = null;
  heartbeatPath = '/api/crm/timeproof/heartbeat';
}
