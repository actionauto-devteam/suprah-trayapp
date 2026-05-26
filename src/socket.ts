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

export function connectSocket(
  apiUrl: string,
  token: string,
  onStateChange: StateChangeCallback,
  onReconnect?: () => void,
): void {
  if (socket?.connected) return;

  socket = io(apiUrl, {
    auth: { token },
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
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}

export function isSocketConnected(): boolean {
  return socket?.connected ?? false;
}
