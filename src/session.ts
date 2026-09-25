import axios from 'axios';

export type RefreshOutcome =
  | { kind: 'refreshed'; token: string }
  | { kind: 'authRejected' }
  | { kind: 'unreachable' };

export type ProbeOutcome = 'valid' | 'rejected' | 'unreachable';

export interface TokenClaims {
  expiresAtMs: number | null;
  userId: string | null;
  type: string | null;
}

export const SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
export const TOKEN_REFRESH_WINDOW_MS = 2 * 60 * 60 * 1000;

export const readTokenClaims = (token: unknown): TokenClaims | null => {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown> | null;
    if (payload === null || typeof payload !== 'object') return null;
    const exp = payload.exp;
    const id = typeof payload.id === 'string' ? payload.id : typeof payload.sub === 'string' ? payload.sub : null;
    return {
      expiresAtMs: typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null,
      userId: id,
      type: typeof payload.type === 'string' ? payload.type : null,
    };
  } catch {
    return null;
  }
};

export const getTokenExpiryMs = (token: unknown): number | null => readTokenClaims(token)?.expiresAtMs ?? null;

export const shouldRefreshNow = (token: unknown, nowMs: number, windowMs: number): boolean => {
  const claims = readTokenClaims(token);
  if (!claims || claims.type !== 'crm' || claims.expiresAtMs === null) return false;
  return claims.expiresAtMs - nowMs <= windowMs;
};

export const isStaleSameUserToken = (current: unknown, incoming: unknown): boolean => {
  const a = readTokenClaims(current);
  const b = readTokenClaims(incoming);
  if (!a || !b) return false;
  if (a.userId === null || a.userId !== b.userId || a.type !== b.type) return false;
  if (a.expiresAtMs === null || b.expiresAtMs === null) return false;
  return b.expiresAtMs <= a.expiresAtMs;
};

export const isAuthRejection = (err: unknown): boolean =>
  (err as { response?: { status?: number } } | null)?.response?.status === 401;

export const refreshToken = async (apiUrl: string, token: string, timeoutMs = 10_000): Promise<RefreshOutcome> => {
  try {
    const { data } = await axios.post(
      `${apiUrl}/api/crm/token-refresh`,
      {},
      { headers: { Authorization: `Bearer ${token}` }, timeout: timeoutMs }
    );
    const newToken = data?.data?.token;
    return typeof newToken === 'string' && newToken ? { kind: 'refreshed', token: newToken } : { kind: 'unreachable' };
  } catch (err) {
    return isAuthRejection(err) ? { kind: 'authRejected' } : { kind: 'unreachable' };
  }
};

export const probeToken = async (url: string, token: string, timeoutMs = 10_000): Promise<ProbeOutcome> => {
  try {
    await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: timeoutMs });
    return 'valid';
  } catch (err) {
    return isAuthRejection(err) ? 'rejected' : 'unreachable';
  }
};
