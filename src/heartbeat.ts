import axios from 'axios';
import { getIsIdle } from './idle';
import { getScreenRecordingGranted } from './permissions';
import { reportDiagnostic } from './screenshot';

const INTERVAL_MS = 60_000; // every 60 seconds
// Every heartbeat failure used to vanish into a bare `catch {}` — when a real user's
// heartbeat silently stopped landing for 30+ minutes (triggering a stale-shift auto-clockout
// while they were genuinely active), there was no way to tell whether it was a network drop,
// an expired token, or something else. Throttled so a genuine extended outage doesn't spam.
const PING_FAIL_REPORT_COOLDOWN_MS = 10 * 60 * 1000;

type ShiftState = { isOnBreak: boolean; breakDurationSeconds: number; isOnShift: boolean; currentIntervalStartAt: string | null };

let intervalId: ReturnType<typeof setInterval> | null = null;
let _ping: (() => Promise<void>) | null = null;
let heartbeatPath = '/api/crm/timeproof/heartbeat';
let _activeToken = '';
let lastPingFailReportedAt = 0;

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
      await axios.post(
        `${apiUrl}${heartbeatPath}`,
        {
          isIdle, platform: process.platform, isOnBreak, breakDurationSeconds, isOnShift, currentIntervalStartAt,
          screenRecordingGranted: getScreenRecordingGranted(),
        },
        { headers: { Authorization: `Bearer ${_activeToken}` }, timeout: 10_000 }
      );
    } catch (err) {
      // Still best-effort (no retry/queue) — but now leaves a trace instead of vanishing.
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
  heartbeatPath = '/api/crm/timeproof/heartbeat';
}
