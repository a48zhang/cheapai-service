import type {
  AuthApi,
  LoginInput,
  PublicUser,
  RegisterInput,
  RegistrationResult,
} from '@cheapai/api-client/auth';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { SessionIdentity } from '@cheapai/api-client/types';
import type { RuntimeSessionSnapshot } from '../../shared/api/runtime';

export type SessionSnapshot = RuntimeSessionSnapshot;

export class SessionSupersededError extends Error {
  constructor() {
    super('会话操作已被后续操作替代。');
    this.name = 'SessionSupersededError';
  }
}
export class RegistrationIdentityError extends Error {
  constructor(
    readonly registration: RegistrationResult,
    cause: unknown,
  ) {
    super('账户已创建，暂时无法确认身份。请恢复会话或登录，勿重复注册。', { cause });
    this.name = 'RegistrationIdentityError';
  }
}
const asError = (error: unknown) => (error instanceof Error ? error : new Error('会话请求失败。'));

export function createSessionController(api: AuthApi) {
  let snapshot: SessionSnapshot = {
    status: 'unknown',
    user: null,
    epoch: 0,
    pending: null,
    error: null,
    expiry: null,
    publicSettings: null,
    settingsError: null,
  };
  let epoch = 0;
  let writes = 0;
  let writeTail: Promise<unknown> = Promise.resolve();
  let restoreFlight: Promise<PublicUser | null> | null = null;
  let settingsEpoch = 0;
  const listeners = new Set<() => void>();
  function update(patch: Partial<SessionSnapshot>) {
    snapshot = { ...snapshot, ...patch, epoch };
    listeners.forEach((listener) => listener());
  }
  function applyUser(user: PublicUser | null) {
    update({ user, status: user ? 'authenticated' : 'anonymous', error: null, expiry: null });
  }
  function requestIdentity(): SessionIdentity | null {
    return snapshot.status === 'authenticated' && snapshot.user && !snapshot.pending
      ? { userId: snapshot.user.id, epoch }
      : null;
  }
  function expire(identity: SessionIdentity) {
    if (
      identity.epoch !== epoch ||
      snapshot.user?.id !== identity.userId ||
      snapshot.status !== 'authenticated' ||
      writes ||
      snapshot.pending
    )
      return false;
    epoch++;
    update({
      user: null,
      status: 'anonymous',
      pending: null,
      error: null,
      expiry: { ...identity, reason: 'expired' },
    });
    return true;
  }
  function mutate<T>(
    kind: 'login' | 'logout' | 'register',
    operation: () => Promise<{ value: T; user: PublicUser | null }>,
  ): Promise<T> {
    const ticket = ++epoch;
    writes++;
    update({ pending: kind, error: null });
    const running = writeTail.then(async () => {
      try {
        const result = await operation();
        if (ticket !== epoch) throw new SessionSupersededError();
        applyUser(result.user);
        return result.value;
      } catch (error) {
        if (ticket === epoch)
          update({
            error: asError(error),
            ...(error instanceof RegistrationIdentityError
              ? { user: null, status: 'unavailable' as const }
              : {}),
          });
        throw error;
      } finally {
        writes--;
        if (ticket === epoch) update({ pending: null });
      }
    });
    writeTail = running.catch(() => undefined);
    return running;
  }
  function restore(): Promise<PublicUser | null> {
    if (restoreFlight) return restoreFlight;
    restoreFlight = (async () => {
      while (writes) await writeTail;
      const ticket = ++epoch;
      update({ pending: 'restore', error: null });
      try {
        const user = await api.me();
        if (ticket !== epoch) throw new SessionSupersededError();
        applyUser(user);
        return user;
      } catch (error) {
        if (ticket !== epoch) throw new SessionSupersededError();
        if (error instanceof ApiClientError && error.status === 401) {
          applyUser(null);
          return null;
        }
        update({ status: 'unavailable', error: asError(error) });
        throw error;
      } finally {
        if (ticket === epoch) update({ pending: null });
      }
    })().finally(() => {
      restoreFlight = null;
    });
    return restoreFlight;
  }
  async function bootstrap() {
    const ticket = ++settingsEpoch;
    update({ settingsError: null });
    try {
      const settings = await api.bootstrap();
      if (ticket === settingsEpoch) update({ publicSettings: settings });
      return settings;
    } catch (error) {
      if (ticket === settingsEpoch) update({ settingsError: asError(error) });
      throw error;
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    requestIdentity,
    expire,
    restore,
    bootstrap,
    login: (input: LoginInput) =>
      mutate('login', async () => {
        const user = await api.login(input);
        return { user, value: user };
      }),
    logout: () =>
      mutate('logout', async () => {
        await api.logout();
        return { user: null, value: undefined };
      }),
    register: (input: RegisterInput) =>
      mutate('register', async () => {
        const result = await api.register(input);
        let user: PublicUser | null = null;
        if (result.session === 'created') {
          try {
            user = await api.me();
          } catch (error) {
            throw new RegistrationIdentityError(result, error);
          }
        }
        return { value: result, user };
      }),
  };
}
export type SessionController = ReturnType<typeof createSessionController>;
