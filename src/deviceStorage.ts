export interface DeviceCredential {
  deviceId: string;
  deviceSecret: string;
  userId?: string;
}

export interface SecureCipher {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

export interface KeyValueStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

const DEVICE_KEY = 'trayDevice';
const PAUSED_KEY = 'autoSignInPaused';

interface StoredDevice {
  v: 1;
  deviceId: string;
  secret: string;
  userId?: string;
}

export const loadDeviceCredential = (store: KeyValueStore, cipher: SecureCipher): DeviceCredential | null => {
  const raw = store.get(DEVICE_KEY);
  if (raw === null || typeof raw !== 'object') return null;
  const stored = raw as Partial<StoredDevice>;
  if (stored.v !== 1 || typeof stored.deviceId !== 'string' || typeof stored.secret !== 'string') return null;
  if (!cipher.isAvailable()) return null;
  try {
    const deviceSecret = cipher.decrypt(stored.secret);
    if (!deviceSecret) return null;
    return {
      deviceId: stored.deviceId,
      deviceSecret,
      ...(typeof stored.userId === 'string' && stored.userId !== '' && { userId: stored.userId }),
    };
  } catch {
    return null;
  }
};

export const saveDeviceCredential = (
  store: KeyValueStore,
  cipher: SecureCipher,
  credential: DeviceCredential,
): boolean => {
  if (!cipher.isAvailable() || !credential.deviceId || !credential.deviceSecret) return false;
  try {
    const stored: StoredDevice = {
      v: 1,
      deviceId: credential.deviceId,
      secret: cipher.encrypt(credential.deviceSecret),
      ...(credential.userId && { userId: credential.userId }),
    };
    store.set(DEVICE_KEY, stored);
    return true;
  } catch {
    return false;
  }
};

export const deviceCredentialExists = (store: KeyValueStore): boolean => {
  const raw = store.get(DEVICE_KEY);
  return raw !== null && typeof raw === 'object';
};

export const clearDeviceCredential = (store: KeyValueStore): void => {
  store.delete(DEVICE_KEY);
};

export const isAutoSignInPaused = (store: KeyValueStore): boolean => store.get(PAUSED_KEY) === true;

export const setAutoSignInPaused = (store: KeyValueStore, paused: boolean): void => {
  if (paused) store.set(PAUSED_KEY, true);
  else store.delete(PAUSED_KEY);
};
