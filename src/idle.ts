import { powerMonitor } from 'electron';

const IDLE_THRESHOLD_SEC = 10 * 60; // 10 minutes
const CHECK_INTERVAL_MS = 30_000;

type IdleCallback = (isIdle: boolean) => void;

let intervalId: ReturnType<typeof setInterval> | null = null;
let lastIdleState = false;
// Raw OS idle seconds captured when flag set — exposed for diagnostics.
// Lets main.ts distinguish genuine OS idle stretches (hardware/input dropout)
// from bugs in how the flag is used, instead of only seeing a boolean.
let lastIdleSeconds = 0;

export function getLastIdleSeconds(): number {
  return lastIdleSeconds;
}

// Rolling ~30s history of idle readings for diagnostics.
// Shows trend before flag: gradual climb (e.g. 580→590→600→605) vs sudden jump (15→20→605).
// Distinguishes genuine inactivity from sleep/wake or clock events, invisible from final number alone.
const IDLE_HISTORY_LENGTH = 6; // ~3 minutes of readings
let idleSecondsHistory: number[] = [];

export function getIdleSecondsHistory(): number[] {
  return [...idleSecondsHistory];
}
// Hidden exemption: Web Dev dept only (see backend isIdleDetectionExemptDept).
// Set once per login via main.ts based on user's department.
// No UI/toggle; backend silently disables idle detection for this dept.
let idleDetectionExempt = false;

export function setIdleDetectionExempt(value: boolean): void {
  idleDetectionExempt = value;
}

// Fires every Nth tick regardless of idle flag — ensures diagnostic trace
// even if detection never fires. Distinguishes dead loop vs genuine activity
// by recording OS-reported values throughout the test window.
const PERIODIC_REPORT_EVERY_N_TICKS = 10; // ~5 minutes at CHECK_INTERVAL_MS=30s
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

// Allows main.ts to force idle flag sync with agentState.isIdle on resume,
// avoiding 30s tick delay. First OS reading after long sleep may misreport,
// so forcing lastIdleState=true ensures next tick flips correctly to active
// when idle seconds drop, preventing missed idle→active transition.
export function forceIdleState(value: boolean): void {
  lastIdleState = value;
}
