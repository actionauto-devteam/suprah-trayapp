import { BrowserWindow, ipcMain, app, desktopCapturer, Notification } from 'electron';
import path from 'path';
import fs from 'fs';

export type RecordingStatus = 'idle' | 'recording' | 'saving';

let recorderWindow: BrowserWindow | null = null;
let status: RecordingStatus = 'idle';
let onStatusChange: ((s: RecordingStatus) => void) | null = null;
let onChunkReady: ((audioBuffer: Buffer, chunkIndex: number) => void) | null = null;
let ipcHandlersRegistered = false;

export function getRecordingStatus(): RecordingStatus {
  return status;
}

function setStatus(s: RecordingStatus) {
  status = s;
  onStatusChange?.(s);
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
      preload: path.join(__dirname, 'recording-preload.js'),
    },
  });

  // Auto-select the primary screen + loopback system audio — no OS picker dialog
  win.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length === 0) {
        callback({} as any);
        return;
      }
      // Pick the primary/first screen
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback({} as any));
  });

  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    const allowed = ['media', 'display-capture', 'audioCapture', 'videoCapture'];
    cb(allowed.some(p => permission.includes(p)));
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'recorder.html'));
  win.on('closed', () => { recorderWindow = null; });

  return win;
}

export async function startRecording(
  meetingId: string,
  opts: {
    onStatusChange?: (s: RecordingStatus) => void;
    onChunkReady?: (audioBuffer: Buffer, chunkIndex: number) => void;
  } = {}
): Promise<void> {
  if (status === 'recording') return;

  onStatusChange = opts.onStatusChange ?? null;
  onChunkReady = opts.onChunkReady ?? null;

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

  // Get the primary screen source ID to pass to the renderer
  const sources = await desktopCapturer.getSources({ types: ['screen'] });
  const sourceId = sources[0]?.id ?? '';

  recorderWindow?.webContents.send('recording:start', { sourceId, meetingId });
  setStatus('recording');
}

export function stopRecording(): Promise<string | null> {
  if (status !== 'recording') return Promise.resolve(null);
  setStatus('saving');

  return new Promise((resolve) => {
    if (!recorderWindow || recorderWindow.isDestroyed()) {
      setStatus('idle');
      resolve(null);
      return;
    }

    const timeout = setTimeout(() => {
      setStatus('idle');
      resolve(null);
    }, 30_000);

    ipcMain.once('recording:data-ready', async (_event, { buffer }: { buffer: number[] }) => {
      clearTimeout(timeout);

      if (!buffer || buffer.length === 0) {
        setStatus('idle');
        resolve(null);
        return;
      }

      const webmBuffer = Buffer.from(buffer);
      const recordingsDir = path.join(app.getPath('documents'), 'Suprah Recordings');
      if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

      const now = new Date();
      const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
      const filePath = path.join(recordingsDir, `${ts}.webm`);

      try {
        fs.writeFileSync(filePath, webmBuffer);
        setStatus('idle');

        if (Notification.isSupported()) {
          new Notification({
            title: 'Recording saved',
            body: `Saved to Documents/Suprah Recordings/${ts}.webm`,
            silent: false,
          }).show();
        }

        resolve(filePath);
      } catch {
        setStatus('idle');
        resolve(null);
      }
    });

    recorderWindow.webContents.send('recording:stop');
  });
}

export function destroyRecorderWindow(): void {
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.destroy();
    recorderWindow = null;
  }
  setStatus('idle');
}

export function registerRecordingIpcHandlers(): void {
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;

  ipcMain.on('recording:audio-chunk', (_event, { chunk, index }: { chunk: number[]; index: number }) => {
    onChunkReady?.(Buffer.from(chunk), index);
  });

  ipcMain.on('recording:error', (_event, { message }: { message: string }) => {
    setStatus('idle');
    if (Notification.isSupported()) {
      new Notification({
        title: 'Recording failed',
        body: message || 'Could not start screen recording.',
        silent: false,
      }).show();
    }
  });
}
