import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('trayAPI', {
  // Auth — sign-in happens on the dashboard in the browser, which hands a
  // token to the tray app automatically. There is no manual login here.
  logout: () => ipcRenderer.invoke('auth:logout'),

  // Status
  getStatus: () => ipcRenderer.invoke('status:get'),
  openCRM: () => ipcRenderer.invoke('app:open-crm'),
  timeclockAction: (type: string, note?: string) => ipcRenderer.invoke('timeclock:action', type, note),
  checkResumableShift: () => ipcRenderer.invoke('shift:check-resumable'),
  resumeShift: () => ipcRenderer.invoke('shift:resume'),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  openScreenRecordingSettings: () => ipcRenderer.invoke('app:open-screen-recording-settings'),
  downloadUpdate: () => ipcRenderer.invoke('app:download-update'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  signInDevice: () => ipcRenderer.invoke('device:sign-in'),

  // Events from main → renderer
  onStatusUpdate: (cb: (data: unknown) => void) =>
    ipcRenderer.on('status:update', (_e: IpcRendererEvent, data: unknown) => cb(data)),
  onAuthError: (cb: (msg: string) => void) =>
    ipcRenderer.on('auth:error', (_e: IpcRendererEvent, msg: string) => cb(msg)),

  // Remove listeners on cleanup
  removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),
});
