import { desktopCapturer, app, nativeImage } from 'electron';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { getIsIdle } from './idle';
import { enqueue, flushQueue } from './offline-queue';

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const CAPTURE_FAIL_COOLDOWN_MS = 30 * 60 * 1000; // notify at most once per 30 min

let intervalId: ReturnType<typeof setInterval> | null = null;
let apiUrl = '';
let token = '';
let captureFailedCb: (() => void) | null = null;
let lastCaptureFailedAt = 0;

export function setCaptureFailedCallback(cb: () => void): void {
  captureFailedCb = cb;
}

// Use MDT (UTC-6) so shiftDate matches the backend's COMPANY_TZ_OFFSET_MINUTES = -360
const MDT_OFFSET_MS = -6 * 60 * 60 * 1000;
const toShiftDate = () => {
  const mdt = new Date(Date.now() + MDT_OFFSET_MS);
  return `${mdt.getUTCFullYear()}-${String(mdt.getUTCMonth() + 1).padStart(2, '0')}-${String(mdt.getUTCDate()).padStart(2, '0')}`;
};

/**
 * Captures all connected monitors and stitches them horizontally into a single JPEG.
 * Single-monitor setups follow the same path as before (no stitching overhead).
 */
async function captureAllScreens(): Promise<Buffer | null> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1920, height: 1080 },
  });

  if (sources.length === 0) return null;
  if (sources.length === 1) return sources[0].thumbnail.toJPEG(80);

  // Filter out any zero-size thumbnails (disconnected/mirrored displays)
  const images = sources
    .map(s => ({ bitmap: s.thumbnail.toBitmap(), size: s.thumbnail.getSize() }))
    .filter(img => img.size.width > 0 && img.size.height > 0);

  if (images.length === 0) return null;
  if (images.length === 1) {
    return nativeImage.createFromBitmap(images[0].bitmap, images[0].size).toJPEG(80);
  }

  // Stitch monitors side-by-side using raw RGBA bitmap data
  const totalWidth = images.reduce((sum, img) => sum + img.size.width, 0);
  const maxHeight = Math.max(...images.map(img => img.size.height));

  // Allocate combined buffer (zeroed = black padding for shorter monitors)
  const stitched = Buffer.alloc(totalWidth * maxHeight * 4, 0);

  let xOffset = 0;
  for (const img of images) {
    for (let y = 0; y < img.size.height; y++) {
      const srcStart = y * img.size.width * 4;
      const dstStart = (y * totalWidth + xOffset) * 4;
      img.bitmap.copy(stitched, dstStart, srcStart, srcStart + img.size.width * 4);
    }
    xOffset += img.size.width;
  }

  const combined = nativeImage.createFromBitmap(stitched, { width: totalWidth, height: maxHeight });
  // Slightly lower quality for combined image to keep file size reasonable
  return combined.toJPEG(75);
}

async function captureAndUpload(): Promise<void> {
  // Skip regular interval captures while idle — one-off idle snapshot is handled separately
  if (getIsIdle()) return;

  try {
    const jpegBuffer = await captureAllScreens();
    if (!jpegBuffer) return;

    const capturedAt = new Date().toISOString();
    const shiftDate = toShiftDate();

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
    // Notify the user (throttled) — upload failures are handled by the offline queue
    // and are not errors worth notifying. Only actual capture errors reach here.
    const now = Date.now();
    if (captureFailedCb && now - lastCaptureFailedAt > CAPTURE_FAIL_COOLDOWN_MS) {
      lastCaptureFailedAt = now;
      captureFailedCb();
    }
  }
}

/**
 * Captures one screenshot and uploads it with idleDetected=true.
 * Called once when the user goes idle so admin gets a snapshot of what was on screen.
 */
export async function captureAndUploadOnce(url: string, authToken: string): Promise<void> {
  try {
    const jpegBuffer = await captureAllScreens();
    if (!jpegBuffer) return;

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

export function isScreenshotRunning(): boolean {
  return intervalId !== null;
}

export function updateToken(newToken: string): void {
  token = newToken;
}
