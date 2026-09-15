import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('idleRecorderAPI', {
  onStart: (cb: (data: { sourceId: string }) => void) =>
    ipcRenderer.on('idle-recording:start', (_e, data) => cb(data)),

  onStop: (cb: () => void) =>
    ipcRenderer.on('idle-recording:stop', () => cb()),

  sendReady: (buffer: number[]) =>
    ipcRenderer.send('idle-recording:data-ready', { buffer }),

  sendError: (message: string) =>
    ipcRenderer.send('idle-recording:error', { message }),
});
