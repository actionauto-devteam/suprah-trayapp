import axios from 'axios';
import type { DeviceCredential } from './deviceStorage';

export interface DeviceMeta {
  label: string;
  platform: string;
  appVersion: string;
}

export interface SessionUser {
  id: string;
  fullName: string;
}

export type TerminalCode =
  | 'DEVICE_REVOKED'
  | 'DEVICE_UNKNOWN'
  | 'DEVICE_EXPIRED'
  | 'USER_DISABLED'
  | 'ORG_ACCESS_REMOVED';

export type ConnectOutcome =
  | { kind: 'session'; token: string; user: SessionUser; credentials?: DeviceCredential; registered?: boolean; switched?: boolean }
  | { kind: 'preview'; websiteName: string; websiteUserId: string }
  | { kind: 'mismatch'; registeredName: string; websiteName: string }
  | { kind: 'shiftInProgress'; registeredName: string }
  | { kind: 'needsSetup' }
  | { kind: 'codeInvalid' }
  | { kind: 'terminal'; code: TerminalCode }
  | { kind: 'disabled' }
  | { kind: 'unreachable' };

export type RegisterOutcome =
  | { kind: 'registered'; credentials: DeviceCredential }
  | { kind: 'authRejected' }
  | { kind: 'disabled' }
  | { kind: 'unreachable' };

export type DisconnectOutcome = 'ok' | 'unknown' | 'unreachable';

export const CLEARS_CREDENTIAL: ReadonlySet<TerminalCode> = new Set<TerminalCode>([
  'DEVICE_REVOKED',
  'DEVICE_UNKNOWN',
  'DEVICE_EXPIRED',
]);

const TERMINAL_CODES: ReadonlySet<string> = new Set<string>([
  'DEVICE_REVOKED',
  'DEVICE_UNKNOWN',
  'DEVICE_EXPIRED',
  'USER_DISABLED',
  'ORG_ACCESS_REMOVED',
]);

const DISABLED_CODES: ReadonlySet<string> = new Set<string>(['TRAY_DEVICE_AUTH_OFF', 'TRAY_DEVICE_AUTH_DISABLED']);

export const RECONNECT_DELAYS_MS = [5_000, 15_000, 60_000, 300_000] as const;

export const nextReconnectDelayMs = (failures: number): number =>
  RECONNECT_DELAYS_MS[Math.min(Math.max(failures, 1), RECONNECT_DELAYS_MS.length) - 1];

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const parseCredentials = (value: unknown): DeviceCredential | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  return typeof raw.deviceId === 'string' && raw.deviceId && typeof raw.deviceSecret === 'string' && raw.deviceSecret
    ? { deviceId: raw.deviceId, deviceSecret: raw.deviceSecret }
    : undefined;
};

const classifyConnectError = (err: unknown): ConnectOutcome => {
  const response = (err as { response?: { status?: number; data?: Record<string, unknown> } } | null)?.response;
  const status = response?.status;
  const data = response?.data ?? {};
  const code = asString(data.code);
  if (status === 409 && code === 'ACCOUNT_MISMATCH') {
    return { kind: 'mismatch', registeredName: asString(data.registeredName), websiteName: asString(data.websiteName) };
  }
  if (status === 409 && code === 'SHIFT_IN_PROGRESS') {
    return { kind: 'shiftInProgress', registeredName: asString(data.registeredName) };
  }
  if (code === 'NEEDS_SETUP') return { kind: 'needsSetup' };
  if (code === 'CODE_INVALID') return { kind: 'codeInvalid' };
  if (TERMINAL_CODES.has(code)) return { kind: 'terminal', code: code as TerminalCode };
  if (DISABLED_CODES.has(code)) return { kind: 'disabled' };
  return { kind: 'unreachable' };
};

export const connectWithDevice = async (
  apiUrl: string,
  params: {
    credential?: DeviceCredential | null;
    bootstrapCode?: string;
    confirmSwitch?: boolean;
    preview?: boolean;
    meta: DeviceMeta;
  },
  timeoutMs = 15_000,
): Promise<ConnectOutcome> => {
  const body = {
    ...(params.credential && { deviceId: params.credential.deviceId, deviceSecret: params.credential.deviceSecret }),
    ...(params.bootstrapCode && { bootstrapCode: params.bootstrapCode }),
    ...(params.confirmSwitch && { confirmSwitch: true }),
    ...(params.preview && { preview: true }),
    label: params.meta.label,
    platform: params.meta.platform,
    appVersion: params.meta.appVersion,
  };
  try {
    const { data } = await axios.post(`${apiUrl}/api/tray-device/connect`, body, { timeout: timeoutMs });
    const payload = (data?.data ?? data) as Record<string, unknown> | null;
    const preview = payload?.preview as Record<string, unknown> | undefined;
    if (preview && typeof preview.websiteName === 'string' && typeof preview.websiteUserId === 'string') {
      return { kind: 'preview', websiteName: preview.websiteName, websiteUserId: preview.websiteUserId };
    }
    const user = payload?.user as Record<string, unknown> | undefined;
    if (typeof payload?.token === 'string' && payload.token && user && typeof user.id === 'string' && user.id) {
      const credentials = parseCredentials(payload.credentials);
      return {
        kind: 'session',
        token: payload.token,
        user: { id: user.id, fullName: asString(user.fullName) },
        ...(credentials && { credentials: { ...credentials, userId: user.id } }),
        ...(payload.registered === true && { registered: true }),
        ...(payload.switched === true && { switched: true }),
      };
    }
    return { kind: 'unreachable' };
  } catch (err) {
    return classifyConnectError(err);
  }
};

export const registerWithSession = async (
  apiUrl: string,
  token: string,
  meta: DeviceMeta,
  timeoutMs = 15_000,
): Promise<RegisterOutcome> => {
  try {
    const { data } = await axios.post(`${apiUrl}/api/tray-device/register-session`, meta, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: timeoutMs,
    });
    const payload = (data?.data ?? data) as Record<string, unknown> | null;
    const credentials = parseCredentials(payload?.credentials);
    return credentials ? { kind: 'registered', credentials } : { kind: 'unreachable' };
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: Record<string, unknown> } } | null)?.response;
    if (response?.status === 401) return { kind: 'authRejected' };
    if (DISABLED_CODES.has(asString(response?.data?.code))) return { kind: 'disabled' };
    return { kind: 'unreachable' };
  }
};

export const disconnectWithDevice = async (
  apiUrl: string,
  credential: DeviceCredential,
  timeoutMs = 15_000,
): Promise<DisconnectOutcome> => {
  try {
    await axios.post(
      `${apiUrl}/api/tray-device/disconnect`,
      { deviceId: credential.deviceId, deviceSecret: credential.deviceSecret },
      { timeout: timeoutMs },
    );
    return 'ok';
  } catch (err) {
    const response = (err as { response?: { status?: number; data?: Record<string, unknown> } } | null)?.response;
    return response?.status === 401 && asString(response.data?.code) === 'DEVICE_UNKNOWN' ? 'unknown' : 'unreachable';
  }
};
