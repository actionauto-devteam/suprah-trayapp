import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import axios from 'axios';
import { isTrayStandbyRejection } from './trayIdentity';

export interface QueuedActivity {
  userId: string;
  url: string;
  startAt: string;
  endAt: string;
  attempts: number;
}

export interface ActivityFlushResult {
  sent: number;
  dropped: number;
  remaining: number;
  standby: boolean;
  failed: { status: number | null; message: string } | null;
}

const QUEUE_FILE = path.join(app.getPath('userData'), 'activity-queue.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 10_000;
const RETRYABLE_STATUSES = new Set([401, 408, 429]);
const LATE_SEND_MS = 60_000;

let queue: QueuedActivity[] | null = null;
let flushing: Promise<ActivityFlushResult> | null = null;
let flushAgain = false;

const isQueuedActivity = (value: unknown): value is QueuedActivity => {
  const v = value as Partial<QueuedActivity> | null;
  return !!v
    && typeof v.userId === 'string'
    && typeof v.url === 'string'
    && typeof v.startAt === 'string'
    && typeof v.endAt === 'string'
    && Number.isFinite(Date.parse(v.startAt))
    && Number.isFinite(Date.parse(v.endAt));
};

const loadQueue = (): QueuedActivity[] => {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isQueuedActivity)
      .map((e) => ({ ...e, attempts: Number.isFinite(e.attempts) ? e.attempts : 0 }));
  } catch {
    return [];
  }
};

const getQueue = (): QueuedActivity[] => {
  if (!queue) queue = loadQueue();
  return queue;
};

const persist = (): void => {
  const current = getQueue();
  try {
    if (current.length === 0) {
      if (fs.existsSync(QUEUE_FILE)) fs.unlinkSync(QUEUE_FILE);
      return;
    }
    const tmp = `${QUEUE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(current));
    fs.renameSync(tmp, QUEUE_FILE);
  } catch {
  }
};

const removeEntry = (entry: QueuedActivity): void => {
  const current = getQueue();
  const idx = current.indexOf(entry);
  if (idx >= 0) current.splice(idx, 1);
};

export function enqueueActivity(entry: Omit<QueuedActivity, 'attempts'>): void {
  const current = getQueue();
  const existing = current.find((e) => e.userId === entry.userId && e.url === entry.url && e.startAt === entry.startAt);
  if (existing) {
    if (Date.parse(entry.endAt) > Date.parse(existing.endAt)) existing.endAt = entry.endAt;
  } else {
    current.push({ ...entry, attempts: 0 });
  }
  persist();
}

export function oldestUnsentActivityStart(userId: string | null): string | null {
  if (!userId) return null;
  let oldest: number | null = null;
  for (const e of getQueue()) {
    if (e.userId !== userId) continue;
    const ms = Date.parse(e.startAt);
    if (oldest === null || ms < oldest) oldest = ms;
  }
  return oldest === null ? null : new Date(oldest).toISOString();
}

export function latestUnsentActivityEndMs(userId: string | null): number | null {
  if (!userId) return null;
  let latest: number | null = null;
  for (const e of getQueue()) {
    if (e.userId !== userId) continue;
    const ms = Date.parse(e.endAt);
    if (latest === null || ms > latest) latest = ms;
  }
  return latest;
}

const flushOnce = async (apiUrl: string, token: string, userId: string): Promise<ActivityFlushResult> => {
  const result: ActivityFlushResult = { sent: 0, dropped: 0, remaining: 0, standby: false, failed: null };
  const now = Date.now();

  for (const entry of [...getQueue()]) {
    if (now - Date.parse(entry.endAt) > MAX_AGE_MS) {
      removeEntry(entry);
      result.dropped++;
      continue;
    }
    if (entry.userId !== userId) continue;
    if (result.standby) {
      removeEntry(entry);
      result.dropped++;
      continue;
    }
    if (result.failed) continue;

    const sentEndAt = entry.endAt;
    try {
      await axios.post(
        `${apiUrl}${entry.url}`,
        { startAt: entry.startAt, endAt: sentEndAt, resent: entry.attempts > 0 || Date.now() - Date.parse(sentEndAt) > LATE_SEND_MS },
        { headers: { Authorization: `Bearer ${token}` }, timeout: SEND_TIMEOUT_MS },
      );
      if (entry.endAt === sentEndAt) removeEntry(entry);
      result.sent++;
    } catch (err) {
      if (isTrayStandbyRejection(err)) {
        removeEntry(entry);
        result.dropped++;
        result.standby = true;
        continue;
      }
      const axiosErr = err as { response?: { status?: number }; message?: string };
      const status = axiosErr?.response?.status ?? null;
      if (status !== null && status >= 400 && status < 500 && !RETRYABLE_STATUSES.has(status)) {
        removeEntry(entry);
        result.dropped++;
        continue;
      }
      entry.attempts += 1;
      result.failed = { status, message: axiosErr?.message ?? String(err) };
    }
    persist();
  }

  persist();
  result.remaining = getQueue().filter((e) => e.userId === userId).length;
  return result;
};

export function flushActivityQueue(apiUrl: string, token: string, userId: string): Promise<ActivityFlushResult> {
  if (flushing) {
    flushAgain = true;
    return flushing;
  }
  flushing = (async () => {
    let result: ActivityFlushResult;
    do {
      flushAgain = false;
      result = await flushOnce(apiUrl, token, userId);
    } while (flushAgain && !result.failed && !result.standby);
    return result;
  })().finally(() => {
    flushing = null;
    flushAgain = false;
  });
  return flushing;
}
