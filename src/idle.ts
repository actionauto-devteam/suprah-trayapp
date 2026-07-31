import { powerMonitor } from 'electron';

const IDLE_THRESHOLD_SEC = 10 * 60; // 10 minutes
const CHECK_INTERVAL_MS = 30_000;

type IdleCallback = (isIdle: boolean) => void;

let intervalId: ReturnType<typeof setInterval> | null = null;
let lastIdleState = false;
// Raw seconds the OS reported at the moment idle was last flagged — exposed
// so main.ts can attach it to a diagnostic report. Lets us tell a genuine
// OS-reported idle stretch (hardware/driver quirk, wireless input dropout)
// apart from any bug elsewhere in how that flag gets used, instead of only
// ever seeing the boolean result with no way to check the OS's own number.
let lastIdleSeconds = 0;

export function getLastIdleSeconds(): number {
  return lastIdleSeconds;
}

// Rolling history of recent readings (each ~30s apart) — lets a diagnostic
// report show the TREND leading up to a flag, not just the single number at
// the moment it crossed the threshold. A clean climb (e.g. 580, 590, 600,
// 605) reads very differently from a sudden jump (e.g. 15, 20, 605), which
// would point to a sleep/wake or clock event rather than genuine gradual
// inactivity — that distinction is invisible from the final number alone.
const IDLE_HISTORY_LENGTH = 6; // ~3 minutes of readings
let idleSecondsHistory: number[] = [];

export function getIdleSecondsHistory(): number[] {
  return [...idleSecondsHistory];
}
// Web Dev department only, hidden — see isIdleDetectionExemptDept on the
// backend. Set once per login via main.ts based on the logged-in user's
// department. No UI/toggle anywhere; this is a silent, backend-driven
// exemption from the whole idle detection mechanism.
let idleDetectionExempt = false;

export function setIdleDetectionExempt(value: boolean): void {
  idleDetectionExempt = value;
}

// Fires every Nth tick regardless of whether idle was ever flagged — the
// "flagged idle" diagnostic report only exists once detection actually
// fires, which is useless for the failure mode where it never fires at all
// (silence looks identical whether the check loop is dead or just correctly
// seeing continuous activity). This gives a periodic, unconditional trace of
// what the OS is actually reporting throughout a whole test window.
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

// Lets main.ts force this module's own idle flag in step with agentState.isIdle
// on a system resume, without waiting for the next 30s tick's own judgment call.
// getSystemIdleTime()'s first reading right after a long sleep has been observed
// to be OS/hardware-inconsistent about whether it reflects the sleep gap at all —
// forcing lastIdleState=true here means the very next tick still behaves
// correctly (flips back to non-idle the moment it sees genuinely low idle
// seconds, same as any other idle→active transition) instead of silently never
// firing the transition that would otherwise truncate the gap.
export function forceIdleState(value: boolean): void {
  lastIdleState = value;
}
