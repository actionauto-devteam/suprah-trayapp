import { powerMonitor } from 'electron';

const DEBUG_SCALE = Number(process.env.TIMEPROOF_IDLE_DEBUG_SCALE) || 1;
if (DEBUG_SCALE !== 1) {
  console.warn(`[idle] TIMEPROOF_IDLE_DEBUG_SCALE=${DEBUG_SCALE} active — idle thresholds are NOT production values`);
}

export const IDLE_THRESHOLD_SEC = (10 * 60) / DEBUG_SCALE;
export const IDLE_STAGE2_THRESHOLD_SEC = (20 * 60) / DEBUG_SCALE;
export const IDLE_STAGE3_THRESHOLD_SEC = (30 * 60) / DEBUG_SCALE;
export const RECORDING_TRIGGER_THRESHOLD_SEC = 60 / DEBUG_SCALE;
const CHECK_INTERVAL_MS = 30_000;
const CONSECUTIVE_IDLE_SAMPLES_TO_TRIP = 2;
const FROZEN_TIMER_GAP_MS = CHECK_INTERVAL_MS * 3;

type IdleCallback = (isIdle: boolean) => void;
type RecordingThresholdCallback = (shouldRecord: boolean) => void;
type IdleStageCallback = (stage: 2 | 3, idleSeconds: number) => void;

let intervalId: ReturnType<typeof setInterval> | null = null;
let lastIdleState = false;
let lastIdleSeconds = 0;
let idleSampleStreak = 0;
let lastTickAt = 0;
let previousIdleSecondsSample = 0;
let recordingTriggerState = false;
let recordingTriggerStreak = 0;
let stage2Streak = 0;
let stage3Streak = 0;
let lastIdleStage: 0 | 1 | 2 | 3 = 0;
let lastTickReliable = true;

export function getLastIdleSeconds(): number {
  return lastIdleSeconds;
}

export function isLastIdleSampleReliable(): boolean {
  return lastTickReliable;
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

export function startIdleMonitor(
  onIdleChange: IdleCallback,
  onPeriodicCheck?: (idleSeconds: number, exempt: boolean) => void,
  onRecordingThreshold?: RecordingThresholdCallback,
  onIdleStageChange?: IdleStageCallback,
): void {
  if (intervalId) return;

  lastTickAt = Date.now();

  intervalId = setInterval(() => {
    const now = Date.now();
    const wallGapMs = lastTickAt === 0 ? CHECK_INTERVAL_MS : now - lastTickAt;
    lastTickAt = now;

    const idleSeconds = idleDetectionExempt ? 0 : powerMonitor.getSystemIdleTime();
    lastIdleSeconds = idleSeconds;
    lastTickReliable = true;
    idleSecondsHistory = [...idleSecondsHistory, idleSeconds].slice(-IDLE_HISTORY_LENGTH);

    tickCount += 1;
    if (onPeriodicCheck && tickCount % PERIODIC_REPORT_EVERY_N_TICKS === 0) {
      onPeriodicCheck(idleSeconds, idleDetectionExempt);
    }

    if (wallGapMs > FROZEN_TIMER_GAP_MS) {
      idleSampleStreak = 0;
      recordingTriggerStreak = 0;
      stage2Streak = 0;
      stage3Streak = 0;
      previousIdleSecondsSample = idleSeconds;
      lastTickReliable = false;

      const stillIdle = idleSeconds >= IDLE_THRESHOLD_SEC;
      const stillAboveRecordingThreshold = idleSeconds >= RECORDING_TRIGGER_THRESHOLD_SEC;
      const supportedStage: 0 | 1 | 2 | 3 =
        !stillIdle ? 0 : idleSeconds >= IDLE_STAGE3_THRESHOLD_SEC ? 3 : idleSeconds >= IDLE_STAGE2_THRESHOLD_SEC ? 2 : 1;

      if (lastIdleState && !stillIdle) {
        lastIdleState = false;
        onIdleChange(false);
      }
      if (recordingTriggerState && !stillAboveRecordingThreshold) {
        recordingTriggerState = false;
        onRecordingThreshold?.(false);
      }
      lastIdleStage = Math.min(lastIdleStage, supportedStage) as 0 | 1 | 2 | 3;
      return;
    }

    const idleGrowth = idleSeconds - previousIdleSecondsSample;
    previousIdleSecondsSample = idleSeconds;
    const plausibleMaxGrowth = wallGapMs / 1000 + 60;
    if (idleGrowth > plausibleMaxGrowth) {
      idleSampleStreak = 0;
      recordingTriggerStreak = 0;
      stage2Streak = 0;
      stage3Streak = 0;
      lastTickReliable = false;
      return;
    }

    if (idleSeconds >= IDLE_THRESHOLD_SEC) {
      idleSampleStreak += 1;
    } else {
      idleSampleStreak = 0;
    }

    if (idleSeconds >= RECORDING_TRIGGER_THRESHOLD_SEC) {
      recordingTriggerStreak += 1;
    } else {
      recordingTriggerStreak = 0;
    }

    if (idleSeconds >= IDLE_STAGE2_THRESHOLD_SEC) {
      stage2Streak += 1;
    } else {
      stage2Streak = 0;
    }

    if (idleSeconds >= IDLE_STAGE3_THRESHOLD_SEC) {
      stage3Streak += 1;
    } else {
      stage3Streak = 0;
    }

    const isIdle = idleSampleStreak >= CONSECUTIVE_IDLE_SAMPLES_TO_TRIP
      ? true
      : idleSampleStreak === 0
        ? false
        : lastIdleState;

    const shouldRecord = recordingTriggerStreak >= CONSECUTIVE_IDLE_SAMPLES_TO_TRIP
      ? true
      : recordingTriggerStreak === 0
        ? false
        : recordingTriggerState;

    const stage2Confirmed = stage2Streak >= CONSECUTIVE_IDLE_SAMPLES_TO_TRIP;
    const stage3Confirmed = stage3Streak >= CONSECUTIVE_IDLE_SAMPLES_TO_TRIP;

    if (isIdle !== lastIdleState) {
      lastIdleState = isIdle;
      onIdleChange(isIdle);
    }

    if (shouldRecord !== recordingTriggerState) {
      recordingTriggerState = shouldRecord;
      onRecordingThreshold?.(shouldRecord);
    }

    const nextIdleStage: 0 | 1 | 2 | 3 = !isIdle ? 0 : stage3Confirmed ? 3 : stage2Confirmed ? 2 : 1;
    if (nextIdleStage !== lastIdleStage) {
      if ((nextIdleStage === 2 || nextIdleStage === 3) && nextIdleStage > lastIdleStage) {
        onIdleStageChange?.(nextIdleStage, idleSeconds);
      }
      lastIdleStage = nextIdleStage;
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
  previousIdleSecondsSample = 0;
  recordingTriggerState = false;
  recordingTriggerStreak = 0;
  stage2Streak = 0;
  stage3Streak = 0;
  lastIdleStage = 0;
  lastTickReliable = true;
}

export function getIsIdle(): boolean {
  return lastIdleState;
}

export function getShouldRecordIdleVideo(): boolean {
  return recordingTriggerState;
}

export function forceIdleState(value: boolean): void {
  lastIdleState = value;
  idleSampleStreak = value ? CONSECUTIVE_IDLE_SAMPLES_TO_TRIP : 0;
  recordingTriggerState = value;
  recordingTriggerStreak = value ? CONSECUTIVE_IDLE_SAMPLES_TO_TRIP : 0;
  stage2Streak = 0;
  stage3Streak = 0;
  lastIdleStage = value ? 1 : 0;
  lastTickAt = 0;
  previousIdleSecondsSample = 0;
}
