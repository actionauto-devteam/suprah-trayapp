import axios from 'axios';
import { getIsIdle } from './idle';

const INTERVAL_MS = 60_000; // every 60 seconds

type ShiftState = { isOnBreak: boolean; breakDurationSeconds: number; isOnShift: boolean; currentIntervalStartAt: string | null };

let intervalId: ReturnType<typeof setInterval> | null = null;
let _ping: (() => Promise<void>) | null = null;

export function startHeartbeat(apiUrl: string, token: string, getShiftState: () => ShiftState): void {
  if (intervalId) return;

  _ping = async () => {
    try {
      const { isOnBreak, breakDurationSeconds, isOnShift, currentIntervalStartAt } = getShiftState();
      const isIdle = isOnBreak || !isOnShift ? false : getIsIdle();
      await axios.post(
        `${apiUrl}/api/crm/timeproof/heartbeat`,
        { isIdle, platform: process.platform, isOnBreak, breakDurationSeconds, isOnShift, currentIntervalStartAt },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 }
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
}
