import { powerMonitor } from 'electron';

const IDLE_THRESHOLD_SEC = 10 * 60;
const CHECK_INTERVAL_MS = 30_000;

type IdleCallback = (isIdle: boolean) => void;

let intervalId: ReturnType<typeof setInterval> | null = null;
let lastIdleState = false;
let lastIdleSeconds = 0;

export function getLastIdleSeconds(): number {
  return lastIdleSeconds;
}

const IDLE_HISTORY_LENGTH = 6;
let idleSecondsHistory: number[] = [];

export function getIdleSecondsHistory(): number[] {
  return [...idleSecondsHistory];
}
let idleDetectionExempt = false;

export function setIdleDetectionExempt(value: boolean): void {
  idleDetectionExempt = value;
}

const PERIODIC_REPORT_EVERY_N_TICKS = 10;
let tickCount = 0;

export function startIdleMonitor(onIdleChange: IdleCallback, onPeriodicCheck?: (idleSeconds: number, exempt: boolean) => void): void {
  if (intervalId) return;

  intervalId = setInterval(() => {
    const idleSeconds = idleDetectionExempt ? 0 : powerMonitor.getSystemIdleTime();
    const isIdle = idleSeconds >= IDLE_THRESHOLD_SEC;
    lastIdleSeconds = idleSeconds;
    idleSecondsHistory = [...idleSecondsHistory, idleSeconds].slice(-IDLE_HISTORY_LENGTH);

    if (isIdle !== lastIdleState) {
      lastIdleState = isIdle;
      onIdleChange(isIdle);
    }

    tickCount += 1;
    if (onPeriodicCheck && tickCount % PERIODIC_REPORT_EVERY_N_TICKS === 0) {
      onPeriodicCheck(idleSeconds, idleDetectionExempt);
    }
  }, CHECK_INTERVAL_MS);
}

export function stopIdleMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  lastIdleState = false;
  tickCount = 0;
}

export function getIsIdle(): boolean {
  return lastIdleState;
}

export function forceIdleState(value: boolean): void {
  lastIdleState = value;
}
