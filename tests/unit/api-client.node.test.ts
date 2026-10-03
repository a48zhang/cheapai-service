import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from '../../apps/web/node_modules/typescript';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../packages/api-client/src/client';
import type { ApiRequestOptions, Page } from '../../packages/api-client/src/types';
import { Hono } from '../../apps/worker/node_modules/hono';

const origin = 'https://console.example';
const csrf = 'a'.repeat(43);

function service() {
  const requests: Request[] = [];
  const operations = new Map<string, string>();
  const fetcher: typeof fetch = async (input, init) => {
    // Use real Fetch Request/Headers/Response objects without remote traffic.
    const request = new Request(new URL(String(input), origin), init);
    requests.push(request);
    if (request.method === 'GET') {
      const after = new URL(request.url).searchParams.get('cursor');
      return Response.json({ data: { items: [{ id: after ? 'second' : 'first' }], nextCursor: after ? null : 'page_2' }, request_id: 'server-list' });
    }
    const key = request.headers.get('Idempotency-Key');
    if (!key || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key) || request.headers.get('X-CSRF-Token') !== csrf) {
      return Response.json({ error: { code: 'invalid_request', message: 'Invalid request.' }, request_id: 'server-invalid' }, { status: 400 });
    }
    const payload = await request.text();
    if (operations.has(key) && operations.get(key) !== payload) {
      return Response.json({ error: { code: 'conflict', message: 'Resource conflict.' }, request_id: 'server-conflict' }, { status: 409 });
    }
    const replayed = operations.has(key);
    operations.set(key, payload);
    return Response.json({ data: { replayed }, request_id: 'server-create' }, { status: replayed ? 200 : 201 });
  };
  return { requests, fetcher };
}

describe('management API client contracts', () => {
  it('preserves encoded public model IDs through real Hono model and mapping routes', async () => {
    const app = new Hono();
    for (const route of ['/api/v1/admin/models/:id', '/api/v1/admin/models/:id/mappings', '/api/v1/admin/models/:id/mappings/:channel/:protocol']) {
      app.on(['GET', 'PATCH'], route, c => c.json({ data: { id: c.req.param('id'), channel: c.req.param('channel') ?? null }, request_id: 'model-route' }));
    }
    const fetched: string[] = [];
    const client = createApiClient({ getCsrfToken: () => csrf, fetch: async (input, init) => {
      fetched.push(String(input)); return app.fetch(new Request(new URL(String(input), origin), init));
    } });
    const model = encodeURIComponent('openai/gpt');
    for (const suffix of ['', '/mappings', '/mappings/channel-1/chat']) {
      expect((await client.get<{ id: string }>(`/api/v1/admin/models/${model}${suffix}`)).data.id).toBe('openai/gpt');
      expect((await client.patch<{ id: string }>(`/api/v1/admin/models/${model}${suffix}`, { version: 1 })).data.id).toBe('openai/gpt');
    }
    expect(fetched).toHaveLength(6); expect(fetched.every(value => value.includes('openai%2Fgpt'))).toBe(true);
  });

  it('rejects encoded traversal and slash bypasses outside the exact model parameter', async () => {
    const server = service(); const client = createApiClient({ fetch: server.fetcher });
    for (const value of ['https://evil/api/v1/admin/models/a', '//evil/api/v1/admin/models/a', '/api%2Fv1/admin/models/a',
      '/api/v1/keys/a%2Fb', '/api/v1/admin/models/%2e%2e', '/api/v1/admin/models/openai%2F..%2Fgpt',
      '/api/v1/admin/models/openai%2F.%2Fgpt', '/api/v1/admin/models/openai%252Fgpt', '/api/v1/admin/models/%252e%252e',
      '/api/v1/admin/models/openai%5Cgpt', '/api/v1/admin/models/openai%00gpt', '/api/v1/admin/models/openai%7Fgpt',
      '/api/v1/admin/models/openai%2Fgpt/unknown', '/api/v1/admin/models/a/mappings/c%2Fd/chat',
      '/api/v1/admin/models/a%2Fmappings%2F..', '/api/v1/admin/models/%2F%2Fevil']) {
      await expect(client.get(value)).rejects.toMatchObject({ kind: 'request' });
    }
    expect(server.requests).toHaveLength(0);
  });
  it('compiles a real consumer using nextCursor and explicit idempotencyKey without arbitrary headers', () => {
    const virtualFile = fileURLToPath(new URL('./__api_client_contract.ts', import.meta.url));
    const source = `import type { Page, ApiRequestOptions } from '../../packages/api-client/src/types';
      const request: ApiRequestOptions = { method: 'POST', idempotencyKey: 'operation-1' };
      const page: Page<{ id: string }> = { items: [{ id: 'one' }], nextCursor: 'page_2' };
      const cursor: string | null = page.nextCursor;
      // @ts-expect-error Unrestricted headers must not enter the client contract.
      const dangerous: ApiRequestOptions = { headers: { Authorization: 'secret' } };
      void request; void cursor; void dangerous;`;
    const options: ts.CompilerOptions = { strict: true, noEmit: true, skipLibCheck: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreate) => path.resolve(name) === path.resolve(virtualFile)
      ? ts.createSourceFile(name, source, languageVersion, true)
      : original(name, languageVersion, onError, shouldCreate);
    const program = ts.createProgram([virtualFile], options, host);
    const errors = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    expect(errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))).toEqual([]);
  });

  it('constructs protected write requests and supports same-key replay and server conflicts', async () => {
    const server = service();
    const client = createApiClient({ fetch: server.fetcher, getCsrfToken: () => csrf });
    const options: ApiRequestOptions<{ replayed: boolean }> = { idempotencyKey: 'operation-1' };
    expect((await client.post('/api/v1/keys', { name: 'key' }, options)).data).toEqual({ replayed: false });
    expect((await client.post('/api/v1/keys', { name: 'key' }, options)).data).toEqual({ replayed: true });
    await expect(client.post('/api/v1/keys', { name: 'different' }, options)).rejects.toMatchObject({ kind: 'api', code: 'conflict', status: 409 });
    expect(server.requests).toHaveLength(3); // No automatic retries on conflict.
    const first = server.requests[0]!;
    expect(first.url).toBe(`${origin}/api/v1/keys`);
    expect(first.credentials).toBe('same-origin'); expect(first.redirect).toBe('error');
    expect(first.headers.get('Idempotency-Key')).toBe('operation-1');
    expect(first.headers.get('X-CSRF-Token')).toBe(csrf);
    expect(first.headers.get('Content-Type')).toBe('application/json');
    expect(first.headers.get('Authorization')).toBeNull();
  });

  it('rejects invalid keys before fetch with no key content in the error', async () => {
    const server = service();
    const client = createApiClient({ fetch: server.fetcher, getCsrfToken: () => csrf });
    for (const idempotencyKey of ['', ' '.repeat(2), ' leading', 'trailing ', 'line\r\ninjection', 'trailing\n', 'trailing\r\n', 'a'.repeat(129), 'non-ascii-密', 'key:colon', '_leading', null, 42]) {
      const options = { idempotencyKey } as unknown as ApiRequestOptions;
      await expect(client.post('/api/v1/admin/registration/codes', {}, options)).rejects.toMatchObject({ kind: 'request' });
    }
    expect(server.requests).toHaveLength(0);
  });

  it('accepts shared backend key boundaries and never sends keys on ordinary requests', async () => {
    const server = service();
    const client = createApiClient({ fetch: server.fetcher, getCsrfToken: () => csrf });
    for (const key of ['a', 'A0._-b', 'a'.repeat(128)]) {
      await client.post('/api/v1/admin/registration/codes', {}, { idempotencyKey: key });
    }
    await client.get('/api/v1/keys');
    expect(server.requests.at(-1)!.headers.has('Idempotency-Key')).toBe(false);
  });

  it('keeps same-origin path and CSRF guards in force when an idempotency key is supplied', async () => {
    const server = service();
    const client = createApiClient({ fetch: server.fetcher, getCsrfToken: () => null });
    const options: ApiRequestOptions = { idempotencyKey: 'operation-2' };
    await expect(client.post('/api/v1/keys', {}, options)).rejects.toMatchObject({ kind: 'request', code: 'csrf_missing' });
    await expect(client.post('https://other.example/api/v1/keys', {}, options)).rejects.toMatchObject({ kind: 'request' });
    await expect(client.get('/api/v1/keys', options)).rejects.toMatchObject({ kind: 'request' });
    expect(server.requests).toHaveLength(0);
  });

  it('follows the backend nextCursor field through a real response envelope', async () => {
    const server = service();
    const client = createApiClient({ fetch: server.fetcher });
    const first = await client.get<Page<{ id: string }>>('/api/v1/keys');
    const firstData = first.data;
    const second = await client.get<Page<{ id: string }>>('/api/v1/keys', { query: { cursor: firstData.nextCursor } });
    expect(firstData.items).toEqual([{ id: 'first' }]);
    expect(second.data).toEqual({ items: [{ id: 'second' }], nextCursor: null });
    expect(new URL(server.requests[1]!.url).searchParams.get('cursor')).toBe('page_2');
  });
});

describe('protected session expiry transport', () => {
  it('notifies JSON/non-JSON 401 before decoding, excluding public auth and non-401 failures', async () => {
    const identity = { userId: 'user-7', epoch: 7 };
    const notices: unknown[] = [];
    const options = { captureIdentity: () => identity, onUnauthorized: (owner: typeof identity, path: string) => notices.push({ owner, path }) };
    for (const contentType of ['application/json', 'text/html']) {
      const client = createApiClient({ ...options, fetch: async () => new Response('broken', { status: 401, headers: { 'content-type': contentType } }) });
      await expect(client.get('/api/v1/chat/models')).rejects.toMatchObject({ status: 401 });
    }
    for (const path of ['/api/v1/auth/login', '/api/v1/auth/register', '/api/v1/auth/send-verify-code', '/api/v1/settings/public']) {
      const client = createApiClient({ ...options, fetch: async () => new Response('no', { status: 401 }) });
      await expect(client.get(path)).rejects.toMatchObject({ status: 401 });
    }
    const client = createApiClient({ ...options, fetch: async () => new Response('no', { status: 403 }) });
    await expect(client.get('/api/v1/keys')).rejects.toMatchObject({ status: 403 });
    expect(notices).toEqual(Array.from({ length: 2 }, () => ({ owner: identity, path: '/api/v1/chat/models' })));
  });
});
