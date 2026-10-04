import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '@cheapai/api-client/client';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { AuthApi, PublicUser } from '@cheapai/api-client/auth';
import { createSessionController, SessionSupersededError } from './controller';
import { safeReturnPath } from '../../shared/lib/return-path';

const user: PublicUser = {
  id: 'one',
  email_normalized: 'one@example.invalid',
  role: 'user',
  status: 'active',
  group_id: 'g',
  group_status: 'active',
  balance_units: '0',
  email_verified_at: null,
};
function api(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    me: async () => user,
    login: async () => user,
    logout: async () => undefined,
    bootstrap: async () => ({
      registrationMode: 'open',
      emailVerificationEnabled: false,
      csrfToken: 'a'.repeat(43),
    }),
    register: async () => ({ status: 'created', session: 'created', user }),
    sendVerificationCode: async () => ({ status: 'accepted', retry_after_ms: 60_000 }),
    ...overrides,
  };
}
const gate = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

describe('session identity isolation', () => {
  it('captures request identity before CSRF and ignores stale/concurrent expiry', async () => {
    const session = createSessionController(api());
    await session.restore();
    const old = session.requestIdentity()!;
    const token = gate<string>();
    const accepted: boolean[] = [];
    const client = createApiClient({
      captureIdentity: session.requestIdentity,
      onUnauthorized: (identity) => accepted.push(session.expire(identity)),
      getCsrfToken: () => token.promise,
      fetch: async () => new Response('no', { status: 401 }),
    });
    const request = client.post('/api/v1/keys', {}).catch((error) => error);
    await session.login({ email: user.email_normalized, password: 'fixture' });
    token.resolve('a'.repeat(43));
    await request;
    expect(accepted).toEqual([false]);
    expect(session.getSnapshot().status).toBe('authenticated');
    expect(session.expire(old)).toBe(false);
    const current = session.requestIdentity()!;
    expect(session.expire(current)).toBe(true);
    expect(session.expire(current)).toBe(false);
    expect(session.getSnapshot().expiry).toMatchObject({ userId: user.id, reason: 'expired' });
  });
  it('singleflights restoration and does not let a late restore replace a login', async () => {
    const response = gate<PublicUser>();
    const me = vi.fn(() => response.promise);
    const session = createSessionController(api({ me }));
    const restore = session.restore();
    const other = session.restore();
    expect(restore).toBe(other);
    const rejected = expect(restore).rejects.toBeInstanceOf(SessionSupersededError);
    await session.login({ email: user.email_normalized, password: 'fixture' });
    response.resolve({ ...user, id: 'old' });
    await rejected;
    expect(me).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().user?.id).toBe('one');
  });
  it('preserves identity on failed logout and distinguishes unavailable from anonymous', async () => {
    const session = createSessionController(
      api({
        logout: async () => {
          throw new Error('offline');
        },
      }),
    );
    await session.restore();
    await expect(session.logout()).rejects.toThrow();
    expect(session.getSnapshot().status).toBe('authenticated');
    const unavailable = createSessionController(
      api({
        me: async () => {
          throw new ApiClientError('http', 'failure', { status: 503 });
        },
      }),
    );
    await expect(unavailable.restore()).rejects.toThrow();
    expect(unavailable.getSnapshot().status).toBe('unavailable');
    const anonymous = createSessionController(
      api({
        me: async () => {
          throw new ApiClientError('api', 'expired', { status: 401 });
        },
      }),
    );
    await anonymous.restore();
    expect(anonymous.getSnapshot().status).toBe('anonymous');
  });
});
it('constrains return paths after decoding and normalization', () => {
  for (const path of [
    'https://evil.example/',
    '//evil.example/',
    '/%2Fexample',
    '/x/../api/v1/auth/me',
    '/x/%2e%2e/login',
    '/api/v1/keys',
    '/v1/chat',
    '/login',
    '/session-unavailable',
    '/x\\evil',
  ])
    expect(safeReturnPath(path)).toBe('/');
  expect(safeReturnPath('/chat/one?view=history')).toBe('/chat/one?view=history');
});
