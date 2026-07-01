import axios from 'axios';

export interface ActiveCallState {
  meetingId: string;
  conversationId: string;
  title: string | null;
  startedAt: string;
  isHost: boolean;
  canRecord: boolean;
  participantCount: number;
}

let pollInterval: ReturnType<typeof setInterval> | null = null;
let currentCall: ActiveCallState | null = null;
let onChangeCallback: ((call: ActiveCallState | null) => void) | null = null;

export function startCallStatePolling(apiUrl: string, getToken: () => string | undefined, onChange: (call: ActiveCallState | null) => void): void {
  if (pollInterval) return;
  onChangeCallback = onChange;

  const poll = async () => {
    const token = getToken();
    if (!token) return;
    try {
      const { data } = await axios.get(`${apiUrl}/api/calls/my-active-call`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 8_000,
      });
      const incoming: ActiveCallState | null = data?.data ?? null;
      const prevId = currentCall?.meetingId ?? null;
      const nextId = incoming?.meetingId ?? null;

      if (prevId !== nextId || currentCall?.canRecord !== incoming?.canRecord) {
        currentCall = incoming;
        onChangeCallback?.(currentCall);
      }
    } catch {
      // Network error — keep last known state, don't clear
    }
  };

  poll();
  pollInterval = setInterval(poll, 10_000);
}

export function stopCallStatePolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  currentCall = null;
  onChangeCallback = null;
}

export function getCurrentCall(): ActiveCallState | null {
  return currentCall;
}
