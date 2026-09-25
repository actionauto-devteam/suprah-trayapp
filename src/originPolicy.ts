const SUPRASPACE_SUBDOMAIN = 'space';
const DEV_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

const toOrigin = (value: string): string | null => {
  try {
    const origin = new URL(value.trim()).origin;
    return origin === 'null' ? null : origin.toLowerCase();
  } catch {
    return null;
  }
};

export const buildAllowedOrigins = (params: {
  crmUrl?: string;
  extra?: string;
  isPackaged: boolean;
}): string[] => {
  const allowed = new Set<string>();
  const crmOrigin = params.crmUrl ? toOrigin(params.crmUrl) : null;
  if (crmOrigin) {
    allowed.add(crmOrigin);
    const url = new URL(crmOrigin);
    const apexHost = url.hostname.startsWith('www.') ? url.hostname.slice(4) : url.hostname;
    if (apexHost.includes('.')) {
      allowed.add(`${url.protocol}//${apexHost}${url.port ? `:${url.port}` : ''}`);
      allowed.add(`${url.protocol}//${SUPRASPACE_SUBDOMAIN}.${apexHost}${url.port ? `:${url.port}` : ''}`);
    }
  }
  for (const entry of (params.extra ?? '').split(',')) {
    const origin = entry.trim() ? toOrigin(entry) : null;
    if (origin) allowed.add(origin);
  }
  if (!params.isPackaged) DEV_ORIGINS.forEach((origin) => allowed.add(origin));
  return [...allowed];
};

export const matchOrigin = (origin: string | undefined, allowed: string[]): string | null => {
  if (!origin) return null;
  const normalized = toOrigin(origin);
  return normalized !== null && allowed.includes(normalized) ? normalized : null;
};
