import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import FormData from 'form-data';
import axios from 'axios';

interface QueueEntry {
  filePath: string;
  shiftDate: string;
  capturedAt: string;
  idleDetected: boolean;
}

const QUEUE_FILE = path.join(app.getPath('userData'), 'screenshot-queue.json');

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

export function enqueue(entry: QueueEntry): void {
  const queue = loadQueue();
  queue.push(entry);
  saveQueue(queue);
}

/** Returns the number of queued screenshots successfully uploaded this call. */
export async function flushQueue(apiUrl: string, token: string): Promise<number> {
  const queue = loadQueue();
  if (queue.length === 0) return 0;

  const remaining: QueueEntry[] = [];
  let uploaded = 0;

  for (const entry of queue) {
    try {
      if (!fs.existsSync(entry.filePath)) continue; // file was deleted, skip

      const form = new FormData();
      form.append('screenshot', fs.createReadStream(entry.filePath), {
        filename: path.basename(entry.filePath),
        contentType: 'image/jpeg',
      });
      form.append('shiftDate', entry.shiftDate);
      form.append('capturedAt', entry.capturedAt);
      form.append('idleDetected', String(entry.idleDetected));

      await axios.post(`${apiUrl}/api/crm/timeproof/screenshots`, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
        timeout: 30_000,
      });

      fs.unlinkSync(entry.filePath); // clean up local copy after upload
      uploaded++;
    } catch {
      remaining.push(entry); // retry next time
    }
  }

  saveQueue(remaining);
  return uploaded;
}
