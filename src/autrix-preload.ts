import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('autrixAPI', {
  // Send a message to Autrix AI with the current transcript as context
  sendMessage: (message: string) =>
    ipcRenderer.invoke('autrix:send-message', message),

  // Get the accumulated call transcript
  getTranscript: () =>
    ipcRenderer.invoke('autrix:get-transcript'),

  // Get call info (title, duration)
  getCallInfo: () =>
    ipcRenderer.invoke('autrix:get-call-info'),

  // Get the auth token for direct API calls
  getToken: () =>
    ipcRenderer.invoke('autrix:get-token'),

  // Get the API base URL
  getApiUrl: () =>
    ipcRenderer.invoke('autrix:get-api-url'),

  // Close the Autrix panel
  close: () =>
    ipcRenderer.invoke('autrix:close'),

  // Transcript update pushed from main when a new chunk is transcribed
  onTranscriptUpdate: (cb: (text: string) => void) =>
    ipcRenderer.on('autrix:transcript-update', (_e: IpcRendererEvent, text: string) => cb(text)),

  // Call ended event
  onCallEnded: (cb: () => void) =>
    ipcRenderer.on('autrix:call-ended', (_e: IpcRendererEvent) => cb()),

  removeAllListeners: (channel: string) =>
    ipcRenderer.removeAllListeners(channel),
});
