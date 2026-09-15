import { BrowserWindow, ipcMain, desktopCapturer, Notification } from 'electron';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { reportDiagnostic } from './screenshot';
import { enqueueIdleRecording, flushIdleRecordingQueue } from './idleRecordingQueue';

export type IdleRecordingStatus = 'idle' | 'recording' | 'uploading';

let recorderWindow: BrowserWindow | null = null;
let status: IdleRecordingStatus = 'idle';
let ipcHandlersRegistered = false;

export function getIdleRecordingStatus(): IdleRecordingStatus {
  return status;
}

function setStatus(s: IdleRecordingStatus): void {
  status = s;
}

function createRecorderWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    skipTaskbar: true,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'idleRecordingPreload.js'),
    },
  });

  win.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length === 0) {
        callback({} as any);
        return;
      }
      callback({ video: sources[0] });
    }).catch(() => callback({} as any));
  });

  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    const allowed = ['media', 'display-capture', 'videoCapture'];
    cb(allowed.some((p) => permission.includes(p)));
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'idleRecorder.html'));
  win.on('closed', () => { recorderWindow = null; });

  return win;
}

const START_RETRY_ATTEMPTS = 3;
const START_RETRY_DELAY_MS = 3_000;

async function attemptStartIdleRecording(): Promise<boolean> {
  if (!recorderWindow || recorderWindow.isDestroyed()) {
    recorderWindow = createRecorderWindow();
  }

  await new Promise<void>((resolve) => {
    if (!recorderWindow || recorderWindow.isDestroyed()) { resolve(); return; }
    if (recorderWindow.webContents.isLoading()) {
      recorderWindow.webContents.once('did-finish-load', () => resolve());
    } else {
      resolve();
    }
  });

  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  const sourceId = sources[0]?.id ?? '';
  if (!sourceId) return false;

  recorderWindow?.webContents.send('idle-recording:start', { sourceId });
  return true;
}

export async function startIdleRecording(): Promise<boolean> {
  if (status !== 'idle') return false;

  for (let attempt = 1; attempt <= START_RETRY_ATTEMPTS; attempt++) {
    const started = await attemptStartIdleRecording();
    if (started) {
      setStatus('recording');
      return true;
    }
    if (attempt < START_RETRY_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, START_RETRY_DELAY_MS));
    }
  }

  reportDiagnostic('idle_recording_no_source', 'No screen source available for idle recording after retries', {
    attempts: START_RETRY_ATTEMPTS,
  });
  return false;
}

const RECORDING_SAVE_TIMEOUT_MS = 30_000;

async function collectRecordingBuffer(): Promise<Buffer | null> {
  if (!recorderWindow || recorderWindow.isDestroyed()) return null;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), RECORDING_SAVE_TIMEOUT_MS);

    ipcMain.once('idle-recording:data-ready', (_event, { buffer }: { buffer: number[] }) => {
      clearTimeout(timeout);
      if (!buffer || buffer.length === 0) {
        resolve(null);
        return;
      }
      resolve(Buffer.from(buffer));
    });

    recorderWindow!.webContents.send('idle-recording:stop');
  });
}

export async function stopAndUploadIdleRecording(
  apiUrl: string,
  authToken: string,
  shiftDate: string,
  idleStartMs: number,
  proofStatus: 'partial' | 'confirmed',
): Promise<void> {
  if (status !== 'recording') return;
  setStatus('uploading');

  let webmBuffer: Buffer | null = null;
  try {
    webmBuffer = await collectRecordingBuffer();
    if (!webmBuffer) {
      setStatus('idle');
      reportDiagnostic('idle_recording_empty', 'Idle proof recording produced no data');
      return;
    }

    flushIdleRecordingQueue(apiUrl, authToken).catch(() => {});

    const form = new FormData();
    form.append('recording', webmBuffer, { filename: `${idleStartMs}.webm`, contentType: 'video/webm' });
    form.append('shiftDate', shiftDate);
    form.append('idleStartMs', String(idleStartMs));
    form.append('status', proofStatus);

    await axios.post(`${apiUrl}/api/crm/timeproof/idle-recordings`, form, {
      headers: { ...form.getHeaders(), Authorization: `Bearer ${authToken}` },
      timeout: 60_000,
    });

    setStatus('idle');
    reportDiagnostic('idle_recording_uploaded', 'Idle proof recording uploaded', { proofStatus, bytes: webmBuffer.length });
  } catch (err) {
    setStatus('idle');
    if (webmBuffer) {
      try {
        enqueueIdleRecording(webmBuffer, shiftDate, idleStartMs, proofStatus);
        reportDiagnostic('idle_recording_queued_for_retry', 'Idle proof recording upload failed — queued locally for retry', {
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      } catch (queueErr) {
        reportDiagnostic('idle_recording_queue_failed', 'Idle proof recording could not be queued locally either', {
          error: queueErr instanceof Error ? queueErr.message : String(queueErr),
        });
      }
    }
    reportDiagnostic('idle_recording_upload_failed', 'Idle proof recording failed to upload', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (Notification.isSupported()) {
      new Notification({
        title: 'Idle proof recording failed',
        body: 'Could not save your idle-period recording. This does not affect your timeclock.',
        silent: true,
      }).show();
    }
  }
}

export function destroyIdleRecorderWindow(): void {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.destroy();
    recorderWindow = null;
  }
  setStatus('idle');
}

export function registerIdleRecordingIpcHandlers(): void {
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;

  ipcMain.on('idle-recording:error', (_event, { message }: { message: string }) => {
    setStatus('idle');
    reportDiagnostic('idle_recording_capture_error', message || 'Idle recording capture failed');
  });
}
