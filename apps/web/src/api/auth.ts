import { createApiClient, readCsrfCookie } from './client.js';
import type { AmountString } from './types.js';

export interface PublicUser {
  readonly id: string;
  readonly email_normalized: string;
  readonly role: 'user' | 'admin';
  readonly status: 'active' | 'disabled';
  readonly group_id: string;
  readonly group_status: 'active' | 'disabled';
  readonly balance_units: AmountString;
  readonly email_verified_at: number | null;
}
export interface PublicSettings {
  readonly registrationMode: 'closed' | 'open' | 'invite';
  readonly emailVerificationEnabled: boolean;
  readonly csrfToken: string;
}
export interface LoginInput { readonly email: string; readonly password: string }
export interface RegisterInput extends LoginInput { readonly registrationCode?: string; readonly emailCode?: string }
export type RegistrationResult = {
  readonly status: 'created'; readonly user: { readonly id: string; readonly email_normalized: string };
} & ({ readonly session: 'created' } | { readonly session: 'login_required'; readonly next_action: 'login' });
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
function invalid(): never { throw new TypeError('Invalid authentication response.'); }
function decodeUser(v: unknown): PublicUser {
  if (!record(v) || !text(v.id) || !text(v.email_normalized) || !text(v.group_id)
    || (v.role !== 'user' && v.role !== 'admin') || (v.status !== 'active' && v.status !== 'disabled')
    || (v.group_status !== 'active' && v.group_status !== 'disabled') || typeof v.balance_units !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(v.balance_units)
    || !(v.email_verified_at === null || (typeof v.email_verified_at === 'number' && Number.isSafeInteger(v.email_verified_at) && v.email_verified_at >= 0))) invalid();
  return { id: v.id, email_normalized: v.email_normalized, role: v.role, status: v.status, group_id: v.group_id,
    group_status: v.group_status, balance_units: v.balance_units, email_verified_at: v.email_verified_at };
}
function decodeSettings(v: unknown): PublicSettings {
  if (!record(v) || typeof v.registrationMode !== 'string' || !['closed', 'open', 'invite'].includes(v.registrationMode)
    || typeof v.emailVerificationEnabled !== 'boolean' || typeof v.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(v.csrfToken) || v.csrfToken.length !== 43) invalid();
  return { registrationMode: v.registrationMode as PublicSettings['registrationMode'], emailVerificationEnabled: v.emailVerificationEnabled, csrfToken: v.csrfToken };
}
function decodeRegistration(v: unknown): RegistrationResult {
  if (!record(v) || v.status !== 'created' || !record(v.user) || !text(v.user.id) || !text(v.user.email_normalized)) invalid();
  const user = { id: v.user.id, email_normalized: v.user.email_normalized };
  if (v.session === 'created') return { status: 'created', user, session: 'created' };
  if (v.session === 'login_required' && v.next_action === 'login') return { status: 'created', user, session: 'login_required', next_action: 'login' };
  return invalid();
}

/** No credentials/user/token persistence in localStorage. Browser owns session cookies. */
export function createAuthApi(options: { fetch?: typeof fetch } = {}) {
  let token: string | null = null;
  let bootstrapping: Promise<PublicSettings> | undefined;
  const client = createApiClient({ ...options, getCsrfToken: () => readCsrfCookie() ?? token });
  function bootstrap(): Promise<PublicSettings> {
    if (!bootstrapping) {
      bootstrapping = client.get('/api/v1/settings/public', { decode: decodeSettings }).then(result => {
        token = result.data.csrfToken; return result.data;
      }).finally(() => { bootstrapping = undefined; });
    }
    return bootstrapping;
  }
  async function ensureCsrf() { if (!(readCsrfCookie() ?? token)) await bootstrap(); }
  return Object.freeze({
    bootstrap,
    async me(): Promise<PublicUser> { return (await client.get('/api/v1/auth/me', { decode: decodeUser })).data; },
    async login(input: LoginInput): Promise<PublicUser> {
      await ensureCsrf(); return (await client.post('/api/v1/auth/login', { email: input.email, password: input.password }, { decode: decodeUser })).data;
    },
    async register(input: RegisterInput): Promise<RegistrationResult> {
      await ensureCsrf(); return (await client.post('/api/v1/auth/register', { email: input.email, password: input.password,
        ...(input.registrationCode === undefined ? {} : { registrationCode: input.registrationCode }),
        ...(input.emailCode === undefined ? {} : { emailCode: input.emailCode }),
      }, { decode: decodeRegistration })).data;
    },
    async logout(): Promise<void> {
      await ensureCsrf(); await client.post('/api/v1/auth/logout', undefined, { decode: value => {
        if (!record(value) || value.loggedOut !== true) invalid(); return undefined;
      } });
    },
    async sendVerificationCode(email: string): Promise<{ status: 'accepted'; retry_after_ms: number }> {
      await ensureCsrf(); return (await client.post('/api/v1/auth/send-verify-code', { email }, { decode: value => {
        if (!record(value) || value.status !== 'accepted' || typeof value.retry_after_ms !== 'number' || !Number.isSafeInteger(value.retry_after_ms) || value.retry_after_ms < 0) invalid();
        return { status: 'accepted' as const, retry_after_ms: value.retry_after_ms };
      } })).data;
    },
  });
}
export type AuthApi = ReturnType<typeof createAuthApi>;
export const authApi = createAuthApi();
