import { describe, expect, it, vi } from 'vitest';
import { DesktopAccountClient } from '../../apps/desktop-runtime/src/cheapai/account-client';

describe('desktop console transport', () => {
  it('uses the fixed account API, private bearer and explicit idempotency key', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{"data":{}}', {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const client = new DesktopAccountClient({
      baseUrl: 'https://accounts.example',
      fetch: fetcher,
    });
    const result = await client.console('private-session', {
      accountId: 'one',
      method: 'POST',
      path: '/api/v1/keys',
      body: '{}',
      idempotencyKey: 'once',
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://accounts.example/api/v1/keys');
    expect(init).toMatchObject({
      method: 'POST',
      body: '{}',
      redirect: 'error',
      headers: { Authorization: 'Bearer private-session', 'Idempotency-Key': 'once' },
    });
    expect(result).toEqual({
      status: 201,
      contentType: 'application/json',
      body: '{"data":{}}',
      encoding: 'utf8',
    });
    expect(JSON.stringify(result)).not.toContain('private-session');
  });

  it('rejects arbitrary URLs, admin APIs and normalized traversal before sending credentials', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new DesktopAccountClient({
      baseUrl: 'https://accounts.example',
      fetch: fetcher,
    });
    for (const path of [
      'https://evil.example/api/v1/keys',
      '//evil.example/api/v1/keys',
      '/api/v1/admin/groups',
      '/api/v1/keys/../auth/me',
      '/api/v1/keys/%2e%2e/auth/me',
      '/api/v1/desktop/key',
    ]) {
      await expect(
        client.console('private-session', { accountId: 'one', method: 'GET', path }),
      ).rejects.toThrow('Unsupported');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves binary image content and error status without retrying uncertain writes', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0, 255, 17, 42]), {
          headers: { 'Content-Type': 'image/png' },
        }),
      )
      .mockResolvedValueOnce(new Response('{"error":{}}', { status: 401 }))
      .mockRejectedValueOnce(new Error('network'));
    const client = new DesktopAccountClient({
      baseUrl: 'https://accounts.example',
      fetch: fetcher,
    });
    expect(
      await client.console('private-session', {
        accountId: 'one',
        method: 'GET',
        path: '/api/v1/images/generations/image/content',
      }),
    ).toMatchObject({ body: 'AP8RKg==', encoding: 'base64', contentType: 'image/png' });
    expect(
      (
        await client.console('private-session', {
          accountId: 'one',
          method: 'GET',
          path: '/api/v1/auth/me',
        })
      ).status,
    ).toBe(401);
    await expect(
      client.console('private-session', {
        accountId: 'one',
        method: 'POST',
        path: '/api/v1/images/generations',
        body: '{}',
      }),
    ).rejects.toThrow('network');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
