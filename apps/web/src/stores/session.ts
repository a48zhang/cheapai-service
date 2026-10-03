import type { SessionIdentity } from '../api/session-expiry.js';
import { computed, reactive, readonly } from 'vue';
import { ApiClientError } from '../api/client.js';
import { authApi } from '../api/auth.js';
import type { AuthApi, LoginInput, PublicSettings, PublicUser, RegisterInput, RegistrationResult } from '../api/auth.js';

export class SessionSupersededError extends Error {
  constructor() { super('会话操作已被后续操作替代。'); this.name = 'SessionSupersededError'; }
}
/** Account creation already succeeded. UI must retry restore/login, not register. */
export class RegistrationIdentityError extends Error {
  readonly registration: RegistrationResult;
  constructor(registration: RegistrationResult, cause: unknown) {
    super('账户已创建，但暂时无法确认会话。请重试恢复会话或登录，不要重复注册。', { cause });
    this.name = 'RegistrationIdentityError'; this.registration = registration;
  }
}
export interface SessionState {
  expiry: { readonly reason: 'expired'; readonly userId: string; readonly generation: number } | null;
  status: 'unknown' | 'anonymous' | 'authenticated' | 'unavailable';
  /** Last known identity may remain when status=unavailable; it is not fresh authorization. */
  user: PublicUser | null;
  pending: 'restore' | 'login' | 'logout' | 'register' | null;
  error: Error | null;
  publicSettings: PublicSettings | null;
  settingsError: Error | null;
}
const asError = (value: unknown) => value instanceof Error ? value : new Error('会话请求失败。');

export function createSessionStore(api: AuthApi = authApi) {
  const state = reactive<SessionState>({ expiry: null, status: 'unknown', user: null, pending: null, error: null, publicSettings: null, settingsError: null });
  let epoch = 0;
  let writes = 0;
  let writeTail: Promise<unknown> = Promise.resolve();
  let settingsEpoch = 0;
  const applyUser = (user: PublicUser | null) => { state.expiry = null; state.user = user; state.status = user === null ? 'anonymous' : 'authenticated'; state.error = null; };

  function requestIdentity(): SessionIdentity | null {
    return state.status === 'authenticated' && state.user && state.pending === null
      ? { generation: epoch, userId: state.user.id } : null;
  }
  function expire(identity: SessionIdentity): boolean {
    if (identity.generation !== epoch || state.status !== 'authenticated' || state.user?.id !== identity.userId
      || writes > 0 || state.pending !== null) return false;
    epoch += 1;
    state.expiry = { reason: 'expired', userId: identity.userId, generation: identity.generation };
    state.user = null; state.status = 'anonymous'; state.pending = null; state.error = null;
    return true;
  }

  /** Cookie-changing requests are serialized as well as guarding state commits.
   * Aborting fetch alone cannot undo a Set-Cookie already sent by the server. */
  function mutate<T>(kind: 'login' | 'logout' | 'register', operation: () => Promise<{ value: T; user: PublicUser | null }>): Promise<T> {
    const ticket = ++epoch; writes++; state.pending = kind; state.error = null;
    const running = writeTail.then(async () => {
      try {
        const result = await operation();
        if (ticket !== epoch) throw new SessionSupersededError();
        applyUser(result.user); return result.value;
      } catch (error) {
        if (ticket === epoch) {
          state.error = asError(error);
          if (error instanceof RegistrationIdentityError) { state.user = null; state.status = 'unavailable'; }
        }
        // A rejected logout/login never proves an existing session was revoked.
        throw error;
      } finally {
        writes--; if (ticket === epoch) state.pending = null;
      }
    });
    writeTail = running.catch(() => undefined);
    return running;
  }

  async function restore(): Promise<PublicUser | null> {
    // Do not race a me read against an in-flight Set-Cookie mutation.
    while (writes > 0) await writeTail;
    const ticket = ++epoch; state.pending = 'restore'; state.error = null;
    try {
      const user = await api.me();
      if (ticket !== epoch) throw new SessionSupersededError();
      applyUser(user); return user;
    } catch (error) {
      if (ticket !== epoch) throw new SessionSupersededError();
      if (error instanceof ApiClientError && error.status === 401) { applyUser(null); return null; }
      state.status = 'unavailable'; state.error = asError(error); throw error;
    } finally { if (ticket === epoch) state.pending = null; }
  }
  async function bootstrap(): Promise<PublicSettings> {
    const ticket = ++settingsEpoch; state.settingsError = null;
    try {
      const settings = await api.bootstrap();
      if (ticket === settingsEpoch) state.publicSettings = settings;
      return settings;
    } catch (error) {
      if (ticket === settingsEpoch) state.settingsError = asError(error);
      throw error;
    }
  }
  return Object.freeze({
    state: readonly(state),
    isAuthenticated: computed(() => state.status === 'authenticated'),
    isAdmin: computed(() => state.status === 'authenticated' && state.user?.role === 'admin'),
    bootstrap, restore, requestIdentity, expire,
    login: (input: LoginInput) => mutate('login', async () => { const user = await api.login(input); return { value: user, user }; }),
    logout: () => mutate('logout', async () => { await api.logout(); return { value: undefined, user: null }; }),
    register: (input: RegisterInput): Promise<RegistrationResult> => mutate('register', async () => {
      const result = await api.register(input);
      // Registration returns a minimal user. Fetch identity instead of inventing
      // role/group/balance, and do not replay registration if this read fails.
      let user: PublicUser | null = null;
      if (result.session === 'created') {
        try { user = await api.me(); } catch (cause) { throw new RegistrationIdentityError(result, cause); }
      }
      return { value: result, user };
    }),
  });
}
export const sessionStore = createSessionStore();
