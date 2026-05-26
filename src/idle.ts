import { powerMonitor } from 'electron';

const IDLE_THRESHOLD_SEC = 10 * 60; // 10 minutes
const CHECK_INTERVAL_MS = 30_000;

type IdleCallback = (isIdle: boolean) => void;

let intervalId: ReturnType<typeof setInterval> | null = null;
let lastIdleState = false;

export function startIdleMonitor(onIdleChange: IdleCallback): void {
  if (intervalId) return;

  intervalId = setInterval(() => {
    const idleSeconds = powerMonitor.getSystemIdleTime();
    const isIdle = idleSeconds >= IDLE_THRESHOLD_SEC;

    if (isIdle !== lastIdleState) {
      lastIdleState = isIdle;
      onIdleChange(isIdle);
    }
  }, CHECK_INTERVAL_MS);
}

export function stopIdleMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  lastIdleState = false;
}

export function getIsIdle(): boolean {
  return lastIdleState;
}
