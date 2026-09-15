import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import FormData from 'form-data';
import axios from 'axios';

interface QueueEntry {
  filePath: string;
  shiftDate: string;
  idleStartMs: number;
  chunkIndex: 1 | 2 | 3;
  status: 'partial' | 'confirmed';
}

const QUEUE_FILE = path.join(app.getPath('userData'), 'idle-recording-queue.json');
const CACHE_DIR = path.join(app.getPath('userData'), 'idle-recording-cache');

function loadQueue(): QueueEntry[] {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveQueue(queue: QueueEntry[]): void {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

export function enqueueIdleRecording(buffer: Buffer, shiftDate: string, idleStartMs: number, chunkIndex: 1 | 2 | 3, status: 'partial' | 'confirmed'): void {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const filePath = path.join(CACHE_DIR, `${idleStartMs}-${chunkIndex}-${status}.webm`);
  fs.writeFileSync(filePath, buffer);
  const queue = loadQueue();
  queue.push({ filePath, shiftDate, idleStartMs, chunkIndex, status });
  saveQueue(queue);
}

export async function flushIdleRecordingQueue(apiUrl: string, token: string): Promise<number> {
  const queue = loadQueue();
  if (queue.length === 0) return 0;

  const remaining: QueueEntry[] = [];
  let uploaded = 0;

  for (const entry of queue) {
    try {
      if (!fs.existsSync(entry.filePath)) continue;

      const form = new FormData();
      form.append('recording', fs.createReadStream(entry.filePath), {
        filename: path.basename(entry.filePath),
        contentType: 'video/webm',
      });
      form.append('shiftDate', entry.shiftDate);
      form.append('idleStartMs', String(entry.idleStartMs));
      form.append('chunkIndex', String(entry.chunkIndex));
      form.append('status', entry.status);

      await axios.post(`${apiUrl}/api/crm/timeproof/idle-recordings`, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
        timeout: 60_000,
      });

      fs.unlinkSync(entry.filePath);
      uploaded++;
    } catch {
      remaining.push(entry);
    }
  }

  saveQueue(remaining);
  return uploaded;
}
