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
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),

  // Events from main → renderer
  onStatusUpdate: (cb: (data: unknown) => void) =>
    ipcRenderer.on('status:update', (_e: IpcRendererEvent, data: unknown) => cb(data)),
  onAuthError: (cb: (msg: string) => void) =>
    ipcRenderer.on('auth:error', (_e: IpcRendererEvent, msg: string) => cb(msg)),

  // Remove listeners on cleanup
  removeAllListeners: (channel: string) => ipcRenderer.removeAllListeners(channel),

  // Recording
  startRecording: () => ipcRenderer.invoke('recording:start-request'),
  stopRecording: () => ipcRenderer.invoke('recording:stop-request'),
  onRecordingState: (cb: (state: string) => void) =>
    ipcRenderer.on('recording:state', (_e, state: string) => cb(state)),

  // Autrix AI panel
  openAutrix: () => ipcRenderer.invoke('autrix:open'),
});
