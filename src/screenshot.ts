import { desktopCapturer, app } from 'electron';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { getIsIdle } from './idle';
import { enqueue, flushQueue } from './offline-queue';

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

let intervalId: ReturnType<typeof setInterval> | null = null;
let apiUrl = '';
let token = '';

// Use MDT (UTC-6) so shiftDate matches the backend's COMPANY_TZ_OFFSET_MINUTES = -360
const MDT_OFFSET_MS = -6 * 60 * 60 * 1000;
const toShiftDate = () => {
  const mdt = new Date(Date.now() + MDT_OFFSET_MS);
  return `${mdt.getUTCFullYear()}-${String(mdt.getUTCMonth() + 1).padStart(2, '0')}-${String(mdt.getUTCDate()).padStart(2, '0')}`;
};

async function captureAndUpload(): Promise<void> {
  // Skip regular interval captures while idle — one-off idle snapshot is handled separately
  if (getIsIdle()) return;

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });

    const source = sources[0];
    if (!source) return;

    const image = source.thumbnail;
    const capturedAt = new Date().toISOString();
    const shiftDate = toShiftDate();

    const jpegBuffer = image.toJPEG(80);

    // Try direct upload first
    try {
      await flushQueue(apiUrl, token); // drain any queued items first

      const form = new FormData();
      form.append('screenshot', jpegBuffer, {
        filename: `${Date.now()}.jpg`,
        contentType: 'image/jpeg',
      });
      form.append('shiftDate', shiftDate);
      form.append('capturedAt', capturedAt);
      form.append('idleDetected', 'false');

      await axios.post(`${apiUrl}/api/crm/timeproof/screenshots`, form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` },
        timeout: 30_000,
      });
    } catch {
      // No internet — save locally and queue for later
      const localDir = path.join(app.getPath('userData'), 'screenshot-cache', shiftDate);
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

      const filePath = path.join(localDir, `${Date.now()}.jpg`);
      fs.writeFileSync(filePath, jpegBuffer);

      enqueue({ filePath, shiftDate, capturedAt, idleDetected: false });
    }
  } catch (err) {
    console.error('[screenshot] Capture failed:', err);
  }
}

/**
 * Captures one screenshot and uploads it with idleDetected=true.
 * Called once when the user goes idle so admin gets a snapshot of what was on screen.
 */
export async function captureAndUploadOnce(url: string, authToken: string): Promise<void> {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });
    const source = sources[0];
    if (!source) return;

    const jpegBuffer = source.thumbnail.toJPEG(80);
    const form = new FormData();
    form.append('screenshot', jpegBuffer, { filename: `${Date.now()}.jpg`, contentType: 'image/jpeg' });
    form.append('shiftDate', toShiftDate());
    form.append('capturedAt', new Date().toISOString());
    form.append('idleDetected', 'true');

    await axios.post(`${url}/api/crm/timeproof/screenshots`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${authToken}` },
      timeout: 30_000,
    });
  } catch {
    // Silent fail — best-effort idle snapshot
  }
}

export function startScreenshots(url: string, authToken: string): void {
  if (intervalId) return;
  apiUrl = url;
  token = authToken;
  intervalId = setInterval(captureAndUpload, INTERVAL_MS);
}

export function stopScreenshots(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

export function updateToken(newToken: string): void {
  token = newToken;
}
