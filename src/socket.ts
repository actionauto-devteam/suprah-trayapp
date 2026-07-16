import { io, Socket } from 'socket.io-client';

type ShiftEvent = 'time-in' | 'time-out' | 'break-in' | 'break-out';

export interface ShiftState {
  isOnShift: boolean;
  isOnBreak: boolean;
  shiftStartedAt: string | null;
  breakStartedAt: string | null;
  totalBreakSeconds: number;
  todayTotalWorkedSeconds: number;
}

type StateChangeCallback = (state: Partial<ShiftState>) => void;

let socket: Socket | null = null;
let currentToken = '';

export function connectSocket(
  apiUrl: string,
  token: string,
  onStateChange: StateChangeCallback,
  onReconnect?: () => void,
  onUpdateCheckRequested?: () => void,
): void {
  if (socket?.connected) return;
  currentToken = token;

  socket = io(apiUrl, {
    // clientType marks this connection so the backend can push events to
    // every tray instance at once (see 'tray:check-update' below) without
    // touching the per-user/per-org rooms web clients use.
    auth: { token: currentToken, clientType: 'tray' },
    transports: ['websocket'],
    reconnectionDelay: 3000,
    reconnectionDelayMax: 15000,
  });

  socket.on('connect', () => {
    console.log('[socket] Connected to backend');
    // Do NOT reset shift state here — syncShiftState() in main.ts sets the real
    // initial state. Resetting here causes a race condition where the connect event
    // fires after syncShiftState completes and wipes the correct on-shift status.
    onStateChange({});
  });

  // On reconnect after a drop, re-fetch current state from the server so any
  // clock-in/out actions taken while disconnected are reflected immediately.
  socket.io.on('reconnect', () => {
    console.log('[socket] Reconnected — resyncing shift state');
    onReconnect?.();
  });

  socket.on('disconnect', () => {
    console.log('[socket] Disconnected from backend');
  });

  // CRM broadcasts these events when the user clocks in/out or takes a break
  socket.on('time-in', (data: { shiftStartedAt: string; todayTotalWorkedSeconds?: number }) => {
    onStateChange({ isOnShift: true, isOnBreak: false, shiftStartedAt: data.shiftStartedAt, breakStartedAt: null, totalBreakSeconds: 0, todayTotalWorkedSeconds: data.todayTotalWorkedSeconds ?? 0 });
  });

  socket.on('time-out', () => {
    onStateChange({ isOnShift: false, isOnBreak: false, shiftStartedAt: null, breakStartedAt: null, totalBreakSeconds: 0 });
  });

  socket.on('break-in', (data: { breakStartedAt: string }) => {
    onStateChange({ isOnBreak: true, breakStartedAt: data.breakStartedAt });
  });

  socket.on('break-out', (data: { totalBreakSeconds?: number }) => {
    onStateChange({ isOnBreak: false, breakStartedAt: null, totalBreakSeconds: data?.totalBreakSeconds ?? 0 });
  });

  // Backend pushes this the moment a new tray release is published — check
  // immediately instead of waiting for the next periodic poll.
  socket.on('tray:check-update', () => {
    onUpdateCheckRequested?.();
  });
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
  currentToken = '';
}

/**
 * Keep the socket's JWT in sync when the token is refreshed (proactive
 * 10-hour renewal, or a fresh token pushed from the web after re-auth).
 * The socket.io client only re-reads `socket.auth` on a (re)connection
 * attempt, so a stale token here silently breaks reconnection the next
 * time the transport drops — heartbeat keeps working (it reads its own
 * token per-request) while real-time break/time-in/out sync quietly stops.
 */
export function updateSocketToken(newToken: string): void {
  currentToken = newToken;
  if (!socket) return;
  socket.auth = { token: newToken, clientType: 'tray' };
  if (socket.connected) {
    socket.disconnect();
    socket.connect();
  }
}

export function isSocketConnected(): boolean {
  return socket?.connected ?? false;
}
