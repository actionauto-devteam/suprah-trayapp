import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('trayAPI', {
  // Auth
  login: (email: string, password: string) =>
    ipcRenderer.invoke('auth:login', { email, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),

  // Status
  getStatus: () => ipcRenderer.invoke('status:get'),
  openCRM: () => ipcRenderer.invoke('app:open-crm'),

  // Events from main → renderer
  onStatusUpdate: (cb: (data: unknown) => void) =>
    ipcRenderer.on('status:update', (_e: IpcRendererEvent, data: unknown) => cb(data)),
  onAuthError: (cb: (msg: string) => void) =>
    ipcRenderer.on('auth:error', (_e: IpcRendererEvent, msg: string) => cb(msg)),

  // Remove listeners on cleanup
  removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),
});
