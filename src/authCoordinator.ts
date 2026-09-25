import {
  CLEARS_CREDENTIAL,
  connectWithDevice,
  disconnectWithDevice,
  nextReconnectDelayMs,
  registerWithSession,
} from './deviceAuthCore';
import type { ConnectOutcome, DeviceMeta, TerminalCode } from './deviceAuthCore';
import type { DeviceCredential } from './deviceStorage';

export type ConnectionState = 'connecting' | 'reconnecting' | 'signed_out' | 'first_setup' | 'revoked' | 'failed';

export type ConfirmPrompt =
  | { type: 'register'; accountName: string }
  | { type: 'switch'; registeredName: string; websiteName: string };

export type InfoPrompt = { type: 'shiftInProgress'; registeredName: string };

export type RenewResult = 'renewed' | 'unavailable' | 'unusable';

export type ColdResult =
  | 'signed_in'
  | 'already'
  | 'no_credential'
  | 'paused'
  | 'busy'
  | 'retrying'
  | 'terminal'
  | 'disabled'
  | 'unusable';

export interface CoordinatorStorage {
  load(): DeviceCredential | null;
  save(credential: DeviceCredential): boolean;
  clear(): void;
  exists(): boolean;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
}

export interface CoordinatorDeps {
  apiUrl: string;
  meta(): DeviceMeta;
  storage: CoordinatorStorage;
  getStoredToken(): string | undefined;
  isAuthenticated(): boolean;
  isOnShift(): boolean;
  handleTrayAuth(token: string): Promise<boolean>;
  applyRefreshedToken(token: string): void;
  resetSession(): void;
  readUserId(token: string | undefined): string | null;
  confirm(prompt: ConfirmPrompt): Promise<boolean>;
  inform(prompt: InfoPrompt): void;
  setConnection(state: ConnectionState | null, message?: string): void;
  connect?: typeof connectWithDevice;
  registerSession?: typeof registerWithSession;
  disconnect?: typeof disconnectWithDevice;
  now?(): number;
  schedule?(fn: () => void, delayMs: number): unknown;
  cancel?(handle: unknown): void;
}

export const CONNECTION_MESSAGES = {
  connecting: 'Connecting to TimeProof...',
  reconnecting: "Reconnecting... we'll keep trying.",
  signedOut: "You're signed out. Press Sign in to connect this computer again.",
  firstSetup: 'First-time setup needed. Open Suprah and press Start Shift to finish connecting this computer.',
  revoked: 'This computer was disconnected. Open Suprah and press Start Shift to connect it again.',
  expired: 'This computer was signed out after a long time without use. Open Suprah and press Start Shift to connect it again.',
  inactive: "Your account isn't active. Please contact your admin.",
  requestExpired: 'That connection request expired. Press Start Shift on the website again.',
} as const;

export const createAuthCoordinator = (deps: CoordinatorDeps) => {
  const connect = deps.connect ?? connectWithDevice;
  const registerSession = deps.registerSession ?? registerWithSession;
  const disconnectRemote = deps.disconnect ?? disconnectWithDevice;
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((fn: () => void, delayMs: number): unknown => setTimeout(fn, delayMs));
  const cancel = deps.cancel ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let renewFailures = 0;
  let renewBackoffUntil = 0;
  let renewInFlight: Promise<RenewResult> | null = null;
  let coldInFlight: Promise<ColdResult> | null = null;
  let coldFailures = 0;
  let coldTimer: unknown = null;
  let registerInFlight = false;
  let bootstrapInFlight = false;
  let stopped = false;

  const clearColdTimer = (): void => {
    if (coldTimer !== null) {
      cancel(coldTimer);
      coldTimer = null;
    }
  };

  const saveCredentials = (credentials: DeviceCredential | undefined, userId: string): void => {
    if (credentials) deps.storage.save({ ...credentials, userId });
  };

  const handleTerminal = (code: TerminalCode): void => {
    if (CLEARS_CREDENTIAL.has(code)) deps.storage.clear();
    if (code === 'DEVICE_REVOKED' || code === 'DEVICE_UNKNOWN') deps.setConnection('revoked', CONNECTION_MESSAGES.revoked);
    else if (code === 'DEVICE_EXPIRED') deps.setConnection('failed', CONNECTION_MESSAGES.expired);
    else deps.setConnection('failed', CONNECTION_MESSAGES.inactive);
  };

  const performRenew = async (usedToken: string): Promise<RenewResult> => {
    const credential = deps.storage.load();
    if (!credential) return 'unusable';
    if (now() < renewBackoffUntil) return 'unavailable';
    const outcome = await connect(deps.apiUrl, { credential, meta: deps.meta() });
    if (outcome.kind === 'session') {
      if (deps.getStoredToken() !== usedToken) return 'renewed';
      const expectedUser = deps.readUserId(usedToken);
      const issuedUser = deps.readUserId(outcome.token);
      if (!expectedUser || !issuedUser || expectedUser !== issuedUser) return 'unusable';
      deps.applyRefreshedToken(outcome.token);
      renewFailures = 0;
      renewBackoffUntil = 0;
      return 'renewed';
    }
    if (outcome.kind === 'unreachable') {
      renewFailures += 1;
      renewBackoffUntil = now() + nextReconnectDelayMs(renewFailures);
      return 'unavailable';
    }
    if (outcome.kind === 'terminal') handleTerminal(outcome.code);
    return 'unusable';
  };

  const renewWithDevice = (usedToken: string): Promise<RenewResult> => {
    if (renewInFlight) return renewInFlight;
    const running = performRenew(usedToken).finally(() => {
      renewInFlight = null;
    });
    renewInFlight = running;
    return running;
  };

  const performColdSignIn = async (options: { userInitiated?: boolean }): Promise<ColdResult> => {
    if (stopped) return 'unusable';
    if (deps.isAuthenticated()) return 'already';
    const credential = deps.storage.load();
    if (!credential) return 'no_credential';
    if (deps.storage.isPaused() && !options.userInitiated) {
      deps.setConnection('signed_out', CONNECTION_MESSAGES.signedOut);
      return 'paused';
    }
    if (options.userInitiated) deps.storage.setPaused(false);
    clearColdTimer();
    deps.setConnection('connecting', CONNECTION_MESSAGES.connecting);
    const outcome = await connect(deps.apiUrl, { credential, meta: deps.meta() });
    if (stopped) return 'unusable';
    if (outcome.kind === 'session') {
      if (deps.isAuthenticated()) {
        deps.setConnection(null);
        return 'already';
      }
      const authenticated = await deps.handleTrayAuth(outcome.token);
      if (authenticated) {
        coldFailures = 0;
        deps.setConnection(null);
        return 'signed_in';
      }
      return retryCold();
    }
    if (outcome.kind === 'unreachable') return retryCold();
    if (outcome.kind === 'terminal') {
      handleTerminal(outcome.code);
      return 'terminal';
    }
    deps.setConnection(null);
    return outcome.kind === 'disabled' ? 'disabled' : 'unusable';
  };

  const retryCold = (): ColdResult => {
    coldFailures += 1;
    deps.setConnection('reconnecting', CONNECTION_MESSAGES.reconnecting);
    clearColdTimer();
    coldTimer = schedule(() => {
      coldTimer = null;
      void signInWithDevice();
    }, nextReconnectDelayMs(coldFailures));
    return 'retrying';
  };

  const signInWithDevice = (options: { userInitiated?: boolean } = {}): Promise<ColdResult> => {
    if (coldInFlight) return Promise.resolve('busy');
    const running = performColdSignIn(options).finally(() => {
      coldInFlight = null;
    });
    coldInFlight = running;
    return running;
  };

  const finishBootstrapFailure = (outcome: ConnectOutcome): boolean => {
    if (outcome.kind === 'shiftInProgress') deps.inform({ type: 'shiftInProgress', registeredName: outcome.registeredName });
    else if (outcome.kind === 'needsSetup' || outcome.kind === 'codeInvalid') {
      if (!deps.isAuthenticated()) deps.setConnection('failed', CONNECTION_MESSAGES.requestExpired);
    } else if (outcome.kind === 'terminal') handleTerminal(outcome.code);
    return false;
  };

  const completeWithToken = async (token: string): Promise<boolean> => {
    const authenticated = await deps.handleTrayAuth(token);
    if (authenticated) deps.setConnection(null);
    return authenticated;
  };

  const performBootstrap = async (code: string, options: { requireConfirm: boolean }): Promise<boolean> => {
    const credential = deps.storage.load();
    const currentUserId = deps.isAuthenticated() ? deps.readUserId(deps.getStoredToken()) : null;

    if (!credential) {
      const preview = await connect(deps.apiUrl, { bootstrapCode: code, preview: true, meta: deps.meta() });
      if (preview.kind !== 'preview') return finishBootstrapFailure(preview);
      const sameAsSession = currentUserId !== null && currentUserId === preview.websiteUserId;
      if (!sameAsSession) {
        if (currentUserId !== null && deps.isOnShift()) {
          deps.inform({ type: 'shiftInProgress', registeredName: '' });
          return false;
        }
        if (options.requireConfirm || currentUserId !== null) {
          if (!(await deps.confirm({ type: 'register', accountName: preview.websiteName }))) return false;
        }
      }
      const outcome = await connect(deps.apiUrl, { bootstrapCode: code, meta: deps.meta() });
      if (outcome.kind !== 'session') return finishBootstrapFailure(outcome);
      saveCredentials(outcome.credentials, outcome.user.id);
      if (currentUserId !== null && currentUserId === outcome.user.id) {
        deps.setConnection(null);
        return true;
      }
      if (currentUserId !== null) deps.resetSession();
      return completeWithToken(outcome.token);
    }

    const outcome = await connect(deps.apiUrl, { credential, bootstrapCode: code, meta: deps.meta() });
    if (outcome.kind === 'session') {
      saveCredentials(outcome.credentials, outcome.user.id);
      if (deps.isAuthenticated()) {
        deps.setConnection(null);
        return true;
      }
      return completeWithToken(outcome.token);
    }
    if (outcome.kind === 'mismatch') {
      if (deps.isAuthenticated() && deps.isOnShift()) {
        deps.inform({ type: 'shiftInProgress', registeredName: outcome.registeredName });
        return false;
      }
      const accepted = await deps.confirm({
        type: 'switch',
        registeredName: outcome.registeredName,
        websiteName: outcome.websiteName,
      });
      if (!accepted) return false;
      const switched = await connect(deps.apiUrl, { credential, bootstrapCode: code, confirmSwitch: true, meta: deps.meta() });
      if (switched.kind !== 'session') return finishBootstrapFailure(switched);
      saveCredentials(switched.credentials, switched.user.id);
      if (deps.isAuthenticated()) deps.resetSession();
      return completeWithToken(switched.token);
    }
    return finishBootstrapFailure(outcome);
  };

  const handleBootstrap = async (code: string, options: { requireConfirm: boolean }): Promise<boolean> => {
    if (stopped || bootstrapInFlight || !code) return false;
    if (deps.storage.exists()) deps.storage.setPaused(false);
    bootstrapInFlight = true;
    try {
      return await performBootstrap(code, options);
    } finally {
      bootstrapInFlight = false;
    }
  };

  const ensureRegistered = async (token: string): Promise<void> => {
    if (stopped || registerInFlight || deps.storage.load()) return;
    registerInFlight = true;
    try {
      const outcome = await registerSession(deps.apiUrl, token, deps.meta());
      if (outcome.kind === 'registered') {
        const userId = deps.readUserId(token);
        deps.storage.save({ ...outcome.credentials, ...(userId && { userId }) });
      }
    } finally {
      registerInFlight = false;
    }
  };

  const signOut = (): boolean => {
    if (!deps.storage.exists()) return false;
    deps.storage.setPaused(true);
    clearColdTimer();
    deps.setConnection('signed_out', CONNECTION_MESSAGES.signedOut);
    return true;
  };

  const disconnectThisComputer = async (): Promise<'revoked' | 'local_only' | 'none'> => {
    const credential = deps.storage.load();
    if (!credential) {
      if (!deps.storage.exists()) return 'none';
      deps.storage.clear();
      deps.storage.setPaused(false);
      return 'local_only';
    }
    const outcome = await disconnectRemote(deps.apiUrl, credential);
    deps.storage.clear();
    deps.storage.setPaused(false);
    clearColdTimer();
    deps.setConnection(null);
    return outcome === 'unreachable' ? 'local_only' : 'revoked';
  };

  const handleWake = async (): Promise<boolean> => {
    if (deps.isAuthenticated()) return true;
    if (!deps.storage.exists()) {
      deps.setConnection('first_setup', CONNECTION_MESSAGES.firstSetup);
      return false;
    }
    const result = await signInWithDevice({ userInitiated: true });
    return result === 'signed_in' || result === 'already';
  };

  const stop = (): void => {
    stopped = true;
    clearColdTimer();
  };

  return {
    renewWithDevice,
    signInWithDevice,
    handleBootstrap,
    ensureRegistered,
    signOut,
    disconnectThisComputer,
    handleWake,
    hasCredential: (): boolean => deps.storage.exists(),
    isSignedOutByUser: (): boolean => deps.storage.exists() && deps.storage.isPaused(),
    stop,
  };
};

export type AuthCoordinator = ReturnType<typeof createAuthCoordinator>;
