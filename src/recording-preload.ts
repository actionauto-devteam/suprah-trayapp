import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('recorderAPI', {
  onStart: (cb: (data: { sourceId: string; meetingId: string }) => void) =>
    ipcRenderer.on('recording:start', (_e, data) => cb(data)),

  onStop: (cb: () => void) =>
    ipcRenderer.on('recording:stop', () => cb()),

  sendReady: (buffer: number[]) =>
    ipcRenderer.send('recording:data-ready', { buffer }),

  sendAudioChunk: (chunk: number[], index: number) =>
    ipcRenderer.send('recording:audio-chunk', { chunk, index }),

  sendError: (message: string) =>
    ipcRenderer.send('recording:error', { message }),
});
