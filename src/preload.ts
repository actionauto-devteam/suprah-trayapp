import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('trayAPI', {
  // Auth
  login: (username: string, password: string) =>
    ipcRenderer.invoke('auth:login', { username, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),

  // Status
  getStatus: () => ipcRenderer.invoke('status:get'),
  openCRM: () => ipcRenderer.invoke('app:open-crm'),
  timeclockAction: (type: string) => ipcRenderer.invoke('timeclock:action', type),

  // Events from main → renderer
  onStatusUpdate: (cb: (data: unknown) => void) =>
    ipcRenderer.on('status:update', (_e: IpcRendererEvent, data: unknown) => cb(data)),
  onAuthError: (cb: (msg: string) => void) =>
    ipcRenderer.on('auth:error', (_e: IpcRendererEvent, msg: string) => cb(msg)),

  // Remember Me (persisted via electron-store, not localStorage)
  getRememberedUsername: () => ipcRenderer.invoke('remember:get'),
  setRememberedUsername: (username: string | null) => ipcRenderer.invoke('remember:set', username),

  // Remove listeners on cleanup
  removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),
});
