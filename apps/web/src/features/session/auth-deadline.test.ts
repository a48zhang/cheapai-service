import { afterEach, expect, it, vi } from 'vitest';
import { createAuthApi } from '@cheapai/api-client/auth';
import { createSessionController } from './controller';

afterEach(() => vi.useRealTimers());

it('ends a stalled identity read and lets the user reconnect successfully', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  const account = {
    id: 'one',
    email_normalized: 'one@example.invalid',
    role: 'user',
    status: 'active',
    group_id: 'g',
    group_status: 'active',
    balance_units: '0',
    email_verified_at: null,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => undefined);
    })
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ data: account, request_id: 'reconnected' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  const session = createSessionController(createAuthApi({ fetch: fetcher }));
  const restore = session.restore();
  const failed = expect(restore).rejects.toMatchObject({ code: 'auth_timeout' });
  await vi.advanceTimersByTimeAsync(30_000);
  await failed;
  expect(signal?.aborted).toBe(true);
  expect(session.getSnapshot()).toMatchObject({ status: 'unavailable', pending: null });
  await session.restore();
  expect(session.getSnapshot()).toMatchObject({
    status: 'authenticated',
    pending: null,
    user: account,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('bounds a stalled response body and does not automatically retry a registration write', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            registrationMode: 'open',
            emailVerificationEnabled: false,
            csrfToken: 'a'.repeat(42) + 'A',
          },
          request_id: 'settings',
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
    .mockImplementationOnce(async (_url, init) => {
      signal = init?.signal;
      return new Response(
        new ReadableStream({
          start() {
            /* no response body arrives */
          },
        }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    });
  const api = createAuthApi({ fetch: fetcher });
  await api.bootstrap();
  const failed = expect(
    api.register({ email: 'one@example.invalid', password: 'fixture-password' }),
  ).rejects.toMatchObject({ code: 'auth_timeout' });
  await vi.advanceTimersByTimeAsync(30_000);
  await failed;
  expect(signal?.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
