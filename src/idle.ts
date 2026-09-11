import { powerMonitor } from 'electron';

export const IDLE_THRESHOLD_SEC = 10 * 60;
const CHECK_INTERVAL_MS = 30_000;
const CONSECUTIVE_IDLE_SAMPLES_TO_TRIP = 2;
const FROZEN_TIMER_GAP_MS = CHECK_INTERVAL_MS * 3;

type IdleCallback = (isIdle: boolean) => void;

let intervalId: ReturnType<typeof setInterval> | null = null;
let lastIdleState = false;
let lastIdleSeconds = 0;
let idleSampleStreak = 0;
let lastTickAt = 0;

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

  lastTickAt = Date.now();

  intervalId = setInterval(() => {
    const now = Date.now();
    const wallGapMs = lastTickAt === 0 ? CHECK_INTERVAL_MS : now - lastTickAt;
    lastTickAt = now;

    const idleSeconds = idleDetectionExempt ? 0 : powerMonitor.getSystemIdleTime();
    lastIdleSeconds = idleSeconds;
    idleSecondsHistory = [...idleSecondsHistory, idleSeconds].slice(-IDLE_HISTORY_LENGTH);

    tickCount += 1;
    if (onPeriodicCheck && tickCount % PERIODIC_REPORT_EVERY_N_TICKS === 0) {
      onPeriodicCheck(idleSeconds, idleDetectionExempt);
    }

    if (wallGapMs > FROZEN_TIMER_GAP_MS) {
      idleSampleStreak = 0;
      if (lastIdleState) {
        lastIdleState = false;
        onIdleChange(false);
      }
      return;
    }

    if (idleSeconds > wallGapMs / 1000 + IDLE_THRESHOLD_SEC) {
      idleSampleStreak = 0;
      return;
    }

    if (idleSeconds >= IDLE_THRESHOLD_SEC) {
      idleSampleStreak += 1;
    } else {
      idleSampleStreak = 0;
    }

    const isIdle = idleSampleStreak >= CONSECUTIVE_IDLE_SAMPLES_TO_TRIP
      ? true
      : idleSampleStreak === 0
        ? false
        : lastIdleState;

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
  tickCount = 0;
  idleSampleStreak = 0;
  lastTickAt = 0;
}

export function getIsIdle(): boolean {
  return lastIdleState;
}

export function forceIdleState(value: boolean): void {
  lastIdleState = value;
  idleSampleStreak = value ? CONSECUTIVE_IDLE_SAMPLES_TO_TRIP : 0;
  lastTickAt = 0;
}
