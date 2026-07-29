import axios from 'axios';
import { getIsIdle } from './idle';
import { getScreenRecordingGranted } from './permissions';

const INTERVAL_MS = 60_000; // every 60 seconds

type ShiftState = { isOnBreak: boolean; breakDurationSeconds: number; isOnShift: boolean; currentIntervalStartAt: string | null };

let intervalId: ReturnType<typeof setInterval> | null = null;
let _ping: (() => Promise<void>) | null = null;
let heartbeatPath = '/api/crm/timeproof/heartbeat';
let _activeToken = '';

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
    } catch {
      // Silent fail — heartbeat is best-effort
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
