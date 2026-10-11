import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestChannelRoutes } from '../../apps/worker/gateway/test-channel-route';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken, CSRF_HEADER_NAME } from '../../apps/worker/auth/csrf';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1000;
const origin = 'https://console.example.invalid';
const path = '/api/v1/admin/channels/g20-channel/test';
const credential = 'g20-synthetic-upstream-secret';
let adminCookie: string;
let userCookie: string;
const body = (protocol = 'chat') => ({
  publicModelId: 'g20-model',
  protocol,
  channelVersion: 1,
  mappingVersion: 1,
  priceVersion: 1,
});
function headers(cookie = adminCookie): Headers {
  const csrf = issueCsrfToken();
  return new Headers({
    Cookie: `${cookie}; ${csrf.setCookie.split(';')[0]}`,
    Origin: origin,
    'Content-Type': 'application/json',
    [CSRF_HEADER_NAME]: csrf.token,
  });
}
const chatReply = () =>
  Response.json({
    id: 'provider-id',
    object: 'chat.completion',
    created: 0,
    model: 'upstream-chat',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
const setup = (fetcher = vi.fn(async () => chatReply())) =>
  createTestChannelRoutes({ now: () => now, trustedOrigin: origin, fetch: fetcher });
const actions = async () =>
  (
    await prepare(
      testEnv.DB,
      "SELECT action,redacted_change_json,operation_id FROM admin_audit WHERE action LIKE 'channel.test.%' ORDER BY action",
    ).all()
  ).rows;

beforeEach(async () => {
  await prepare(
    testEnv.DB,
    "INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('g20-group','G20 Group','active',1,0,0)",
  ).run();
  const cookies: string[] = [];
  for (const [id, role] of [
    ['g20-admin', 'admin'],
    ['g20-user', 'user'],
  ]) {
    await prepare(
      testEnv.DB,
      `INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?,'test-only-hash',?,'active','g20-group',2,60,'admin',0,0)`,
      [id!, `${id}@example.invalid`, role!],
    ).run();
    cookies.push((await createCookieSession(testEnv.DB, id!, now)).setCookie.split(';')[0]!);
  }
  [adminCookie, userCookie] = cookies as [string, string];

  await prepare(
    testEnv.DB,
    `INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('g20-channel','G20 Channel','https://provider.example.com/vendor/v1',?,'active',1,2,60,1,0,0)`,
    [credential],
  ).run();
  await prepare(
    testEnv.DB,
    `INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('g20-model','active',?,1,0,4096,0,0)`,
    [JSON.stringify({ input: '1', output: '2' })],
  ).run();
  for (const protocol of ['chat', 'responses', 'messages'])
    await prepare(
      testEnv.DB,
      `INSERT INTO channel_models
    (channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version) VALUES('g20-channel','g20-model',?,?,?,1)`,
      [
        protocol,
        `upstream-${protocol}`,
        JSON.stringify({ protocol, features: [], maxOutputTokens: 128 }),
      ],
    ).run();
});

describe('explicit administrator channel probes using native D1 and mock fetch', () => {
  it.each(['chat', 'responses', 'messages'])(
    'sends exactly one bounded configured %s request after intent audit',
    async (protocol) => {
      const fetcher = vi.fn(async (url: string, init: RequestInit) => {
        expect((await actions()).map((row) => row.action)).toEqual(['channel.test.intent']);
        expect(url).toContain('https://provider.example.com/vendor/v1/');
        const sent = JSON.parse(init.body as string);
        expect(sent.model).toBe(`upstream-${protocol}`);
        expect(sent.stream).toBe(false);
        expect(sent.max_tokens ?? sent.max_output_tokens).toBe(16);
        expect(JSON.stringify(sent)).toContain('Reply OK.');
        if (protocol === 'chat') return chatReply();
        if (protocol === 'messages')
          return Response.json({
            id: 'msg_provider',
            type: 'message',
            role: 'assistant',
            model: 'upstream-messages',
            content: [{ type: 'text', text: 'OK' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 2, output_tokens: 1 },
          });
        return Response.json({
          id: 'resp_provider',
          object: 'response',
          created_at: 0,
          model: 'upstream-responses',
          status: 'completed',
          output: [
            {
              id: 'msg_output',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'OK', annotations: [] }],
            },
          ],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        });
      });
      const app = createTestChannelRoutes({
        now: () => now,
        trustedOrigin: origin,
        fetch: fetcher,
      });
      const response = await app.request(
        path,
        { method: 'POST', headers: headers(), body: JSON.stringify(body(protocol)) },
        testEnv,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const result = await response.json();
      expect(result).toMatchObject({
        data: {
          outcome: 'responded',
          mayIncurUpstreamCost: true,
          userBalanceCharged: false,
          maxOutputTokens: 16,
        },
        request_id: expect.any(String),
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [sentUrl, sentInit] = fetcher.mock.calls[0]!;
      const evidence = result.data.evidence;
      expect(evidence.execution).toBe('response_received');
      expect(evidence.request).toMatchObject({
        method: sentInit.method,
        url: sentUrl,
        body: sentInit.body,
        publicModelId: 'g20-model',
        upstreamModel: `upstream-${protocol}`,
      });
      expect(JSON.parse(evidence.request.body)).toEqual(JSON.parse(String(sentInit.body)));
      const sentHeaders = new Headers(sentInit.headers);
      const authHeader = protocol === 'messages' ? 'x-api-key' : 'authorization';
      expect(sentHeaders.get(authHeader)).toContain(credential);
      expect(evidence.request.headers[authHeader]).toBe('[REDACTED]');
      expect(evidence.response).toMatchObject({
        status: 200,
        url: sentUrl,
        complete: true,
        truncated: false,
      });
      expect(evidence.redirects).toEqual([]);
      expect(await actions()).toHaveLength(2);
      expect(JSON.stringify(result)).not.toContain('g20-synthetic-upstream-secret');
      expect(
        (await prepare(testEnv.DB, 'SELECT count(*) AS n FROM billing_entries').first())?.n,
      ).toBe(0);
      expect((await prepare(testEnv.DB, 'SELECT count(*) AS n FROM requests').first())?.n).toBe(0);
    },
  );

  it('does not trigger fetch or origin resolution on GET or unauthorized calls', async () => {
    const fetcher = vi.fn(async () => chatReply());
    const resolveOrigin = vi.fn(() => origin);
    const app = createTestChannelRoutes({
      now: () => now,
      trustedOrigin: resolveOrigin,
      fetch: fetcher,
    });
    expect((await app.request(path, { headers: headers() }, testEnv)).status).toBe(404);
    expect(
      (
        await app.request(
          path,
          { method: 'POST', headers: headers(userCookie), body: JSON.stringify(body()) },
          testEnv,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          path,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body()),
          },
          testEnv,
        )
      ).status,
    ).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    expect(resolveOrigin).not.toHaveBeenCalled();
  });

  it('rejects CSRF and arbitrary address, credential, owner or prompt fields', async () => {
    const fetcher = vi.fn(async () => chatReply());
    const app = setup(fetcher);
    const invalidHeaders = headers();
    invalidHeaders.set('Origin', 'https://attacker.invalid');
    expect(
      (
        await app.request(
          path,
          { method: 'POST', headers: invalidHeaders, body: JSON.stringify(body()) },
          testEnv,
        )
      ).status,
    ).toBe(403);
    const invalidCsrfHeaders = headers();
    invalidCsrfHeaders.set(CSRF_HEADER_NAME, 'invalid-csrf-token');
    expect(
      (
        await app.request(
          path,
          { method: 'POST', headers: invalidCsrfHeaders, body: JSON.stringify(body()) },
          testEnv,
        )
      ).status,
    ).toBe(403);
    for (const field of ['baseUrl', 'upstreamKey', 'owner', 'prompt', 'max_tokens']) {
      expect(
        (
          await app.request(
            path,
            {
              method: 'POST',
              headers: headers(),
              body: JSON.stringify({ ...body(), [field]: 'untrusted' }),
            },
            testEnv,
          )
        ).status,
      ).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(await actions()).toHaveLength(0);
  });

  it('rejects stale versions and disabled configuration before dispatch', async () => {
    const fetcher = vi.fn(async () => chatReply());
    const app = setup(fetcher);
    const stale = await app.request(
      path,
      {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ ...body(), mappingVersion: 2 }),
      },
      testEnv,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: {
        details: {
          diagnostic: {
            execution: 'not_started',
            request: null,
            response: null,
            failure: { source: 'cheapai', phase: 'configuration' },
          },
        },
      },
    });
    await prepare(testEnv.DB, "UPDATE channels SET status='disabled' WHERE id='g20-channel'").run();
    expect(
      (
        await app.request(
          path,
          { method: 'POST', headers: headers(), body: JSON.stringify(body()) },
          testEnv,
        )
      ).status,
    ).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rechecks actor state after async configuration resolution before dispatch', async () => {
    const fetcher = vi.fn(async () => chatReply());
    const app = createTestChannelRoutes({
      now: () => now,
      fetch: fetcher,
      trustedOrigin: async () => {
        await prepare(testEnv.DB, "UPDATE users SET role='user' WHERE id='g20-admin'").run();
        return origin;
      },
    });
    const response = await app.request(
      path,
      { method: 'POST', headers: headers(), body: JSON.stringify(body()) },
      testEnv,
    );
    expect(response.status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves structured provider errors while redacting credentials and excluding bodies from audit', async () => {
    const providerBody = {
      error: {
        code: 'invalid_api_key',
        message: `Provider rejected credential ${credential}`,
        api_key: credential,
      },
    };
    const fetcher = vi.fn(async () =>
      Response.json(providerBody, {
        status: 401,
        headers: {
          'retry-after': '9',
          'x-request-id': 'provider-request-401',
          'x-provider-secret': credential,
        },
      }),
    );
    const response = await setup(fetcher).request(
      path,
      { method: 'POST', headers: headers(), body: JSON.stringify(body()) },
      testEnv,
    );
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const result = await response.json();
    expect(result).toMatchObject({
      data: {
        outcome: 'http_error',
        upstreamStatus: 401,
        mayIncurUpstreamCost: true,
        evidence: {
          execution: 'response_received',
          response: {
            status: 401,
            format: 'json',
            complete: true,
            truncated: false,
            headers: {
              'retry-after': '9',
              'x-request-id': 'provider-request-401',
            },
          },
          failure: { source: 'upstream', phase: 'headers', code: 'invalid_api_key' },
        },
      },
    });
    expect(result.data.evidence.response.body).toContain('invalid_api_key');
    expect(result.data.evidence.response.body).toContain('[REDACTED]');
    expect(result.data.evidence.failure.message).toContain('Provider rejected credential');
    expect(result.data.evidence.response.headers).not.toHaveProperty('x-provider-secret');
    expect(JSON.stringify(result)).not.toContain(credential);
    const audit = JSON.stringify(await actions());
    expect(audit).not.toContain(credential);
    expect(audit).not.toContain('invalid_api_key');
    expect(audit).not.toContain('Provider rejected credential');
    expect(
      (await prepare(testEnv.DB, 'SELECT count(*) AS n FROM billing_entries').first())?.n,
    ).toBe(0);
    expect((await prepare(testEnv.DB, 'SELECT count(*) AS n FROM requests').first())?.n).toBe(0);
  });

  it.each([
    {
      label: '429 quota JSON',
      status: 429,
      makeResponse: () =>
        Response.json(
          { error: { code: 'insufficient_quota', message: 'Provider quota is exhausted.' } },
          {
            status: 429,
            headers: { 'retry-after': '12' },
          },
        ),
      format: 'json',
      detail: 'insufficient_quota',
      failureCode: 'insufficient_quota',
      failureMessage: 'Provider quota is exhausted.',
    },
    {
      label: '503 plain text',
      status: 503,
      makeResponse: () =>
        new Response('Provider maintenance window is active.', {
          status: 503,
          headers: { 'content-type': 'text/plain', 'x-request-id': 'provider-request-503' },
        }),
      format: 'text',
      detail: 'Provider maintenance window is active.',
      failureCode: null,
      failureMessage: 'Provider maintenance window is active.',
    },
  ])('retains the actual $label response', async ({ status, makeResponse, format, detail, failureCode, failureMessage }) => {
    const fetcher = vi.fn(async () => makeResponse());
    const response = await setup(fetcher).request(
      path,
      { method: 'POST', headers: headers(), body: JSON.stringify(body()) },
      testEnv,
    );
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const result = await response.json();
    expect(result.data).toMatchObject({
      outcome: 'http_error',
      upstreamStatus: status,
      evidence: {
        execution: 'response_received',
        response: {
          status,
          format,
          complete: true,
          truncated: false,
          body: expect.stringContaining(detail),
        },
        failure: {
          source: 'upstream',
          phase: 'headers',
          code: failureCode,
          message: expect.stringContaining(failureMessage),
        },
      },
    });
    expect(JSON.stringify(await actions())).not.toContain(detail);
  });

  it('reports a concrete protocol issue for a complete invalid JSON response and keeps an empty 200 distinct', async () => {
    const invalidResponse = await setup(
      vi.fn(async () => Response.json({ unexpected: 'shape' })),
    ).request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body()) }, testEnv);
    expect(invalidResponse.status).toBe(200);
    const invalid = await invalidResponse.json();
    expect(invalid.data).toMatchObject({
      outcome: 'invalid_response',
      upstreamStatus: 200,
      evidence: {
        response: {
          status: 200,
          format: 'json',
          complete: true,
          truncated: false,
          body: expect.stringContaining('unexpected'),
        },
        failure: { source: 'protocol', phase: 'validation' },
      },
    });
    expect(invalid.data.evidence.failure.issues.length).toBeGreaterThan(0);
    expect(invalid.data.evidence.failure.issues[0].path).toMatch(/^\$/u);
    expect(invalid.data.evidence.failure.issues[0].message.length).toBeGreaterThan(0);

    const emptyResponse = await setup(
      vi.fn(
        async () =>
          new Response(null, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    ).request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body()) }, testEnv);
    expect(emptyResponse.status).toBe(200);
    expect(await emptyResponse.json()).toMatchObject({
      data: {
        outcome: 'invalid_response',
        upstreamStatus: 200,
        evidence: {
          response: {
            status: 200,
            body: '',
            format: 'empty',
            capturedBytes: 0,
            complete: true,
            truncated: false,
          },
          failure: { source: 'protocol', phase: 'validation', code: 'empty' },
        },
      },
    });
  });

  it('marks an oversized 200 body as incomplete and does not pass a truncated JSON fragment to validation as complete', async () => {
    const response = await setup(
      vi.fn(
        async () =>
          new Response(`{"message":"${'x'.repeat(32_769)}`, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    ).request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body()) }, testEnv);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.data).toMatchObject({
      outcome: 'invalid_response',
      upstreamStatus: 200,
      evidence: {
        response: { status: 200, format: 'fragment', complete: false, truncated: true },
        failure: { source: 'protocol', phase: 'validation', code: 'incomplete' },
      },
    });
    expect(result.data.evidence.response.capturedBytes).toBeLessThanOrEqual(32_768);
    expect(result.data.evidence.response.body.length).toBeLessThanOrEqual(32_768);
    expect(result.data.evidence.failure.issues.length).toBeGreaterThan(0);
  });

  it('retains only redacted body fragments when the upstream response stream is interrupted', async () => {
    const credentialPrefix = credential.slice(0, 18);
    const partialBody = `{"error":{"code":"invalid_api_key","message":"Provider rejected ${credentialPrefix}`;
    let emitted = false;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(new TextEncoder().encode(partialBody));
            return;
          }
          controller.error(new Error('Provider body read interrupted.'));
        },
      },
      { highWaterMark: 0 },
    );
    const response = await setup(
      vi.fn(
        async () =>
          new Response(source, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    ).request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body()) }, testEnv);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.data).toMatchObject({
      outcome: 'transport_error',
      upstreamStatus: 200,
      evidence: {
        execution: 'response_received',
        response: { status: 200, format: 'fragment', complete: false, body: expect.any(String) },
        failure: { source: 'transport', phase: 'body' },
      },
    });
    expect(result.data.evidence.response.body).not.toContain(credentialPrefix);
    expect(result.data.evidence.failure.message).not.toContain(credentialPrefix);
    expect(JSON.stringify(result)).not.toContain(credentialPrefix);
  });

  it('classifies a stalled JSON body as a body timeout while retaining its received status and prefix', async () => {
    let emitted = false;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!emitted) {
            emitted = true;
            controller.enqueue(new TextEncoder().encode('{"error":{"message":"still reading'));
            return;
          }
          return new Promise<void>(() => undefined);
        },
      },
      { highWaterMark: 0 },
    );
    const fetcher = vi.fn(
      async () =>
        new Response(source, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const response = await createTestChannelRoutes({
      now: () => now,
      trustedOrigin: origin,
      fetch: fetcher,
      timeoutMs: 50,
    }).request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body()) }, testEnv);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.data).toMatchObject({
      outcome: 'timeout',
      upstreamStatus: 200,
      evidence: {
        execution: 'response_received',
        response: {
          status: 200,
          format: 'fragment',
          complete: false,
          body: expect.stringContaining('still readin'),
        },
        failure: { source: 'transport', phase: 'body' },
      },
    });
    expect(result.data.evidence.response.body).toContain('[REDACTED]');
    expect(result.data.evidence.response.body).not.toContain('still reading');
    expect(['request_timeout', 'idle_timeout']).toContain(result.data.evidence.failure.code);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports transport failure without inventing an HTTP response', async () => {
    const response = await setup(
      vi.fn(async () => {
        throw new Error('provider socket unavailable');
      }),
    ).request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body()) }, testEnv);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.data).toMatchObject({
      outcome: 'transport_error',
      upstreamStatus: null,
      evidence: {
        execution: 'attempted',
        response: null,
        failure: { source: 'transport', code: 'network_error' },
      },
    });
  });

  it('keeps a redirect hop without treating it as a final response when the target fails', async () => {
    const firstUrl = 'https://provider.example.com/vendor/v1/chat/completions';
    const nextUrl = 'https://redirect.example.invalid/target';
    const fetcher = vi.fn(async (url: string) => {
      if (url === firstUrl)
        return new Response(null, { status: 302, headers: { location: nextUrl } });
      throw new Error('redirect target unavailable');
    });
    const response = await setup(fetcher).request(
      path,
      { method: 'POST', headers: headers(), body: JSON.stringify(body()) },
      testEnv,
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.data.upstreamStatus).toBeNull();
    expect(result.data.evidence).toMatchObject({
      execution: 'attempted',
      response: null,
      redirects: [{ url: firstUrl, nextUrl, method: 'POST', status: 302 }],
      failure: { source: 'transport', code: 'network_error' },
    });
    expect(result.data.evidence.failure.phase).not.toBe('body');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([firstUrl, nextUrl]);
  });

  it('returns an explicit timeout diagnostic and aborts the single fetch', async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });
    const app = createTestChannelRoutes({
      now: () => now,
      trustedOrigin: origin,
      fetch: fetcher,
      timeoutMs: 50,
    });
    const response = await app.request(
      path,
      { method: 'POST', headers: headers(), body: JSON.stringify(body()) },
      testEnv,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        outcome: 'timeout',
        upstreamStatus: null,
        evidence: {
          execution: 'attempted',
          response: null,
          failure: { source: 'transport', phase: 'headers' },
        },
      },
    });
    expect(signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch when intent audit fails', async () => {
    await prepare(
      testEnv.DB,
      "CREATE TRIGGER g20_no_intent BEFORE INSERT ON admin_audit WHEN NEW.action='channel.test.intent' BEGIN SELECT RAISE(ABORT,'test audit failure'); END",
    ).run();
    const fetcher = vi.fn(async () => chatReply());
    const response = await setup(fetcher).request(
      path,
      { method: 'POST', headers: headers(), body: JSON.stringify(body()) },
      testEnv,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: {
        details: {
          diagnostic: {
            execution: 'not_started',
            request: null,
            response: null,
            failure: { source: 'cheapai', phase: 'audit' },
          },
        },
      },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves the actual probe response in partial evidence when the post-probe audit fails', async () => {
    await prepare(
      testEnv.DB,
      "CREATE TRIGGER g20_no_result BEFORE INSERT ON admin_audit WHEN NEW.action LIKE 'channel.test.responded%' BEGIN SELECT RAISE(ABORT,'test audit failure'); END",
    ).run();
    const responseMarker = 'provider-response-body-sentinel';
    const fetcher = vi.fn(async () =>
      Response.json({
        id: 'provider-id',
        object: 'chat.completion',
        created: 0,
        model: 'upstream-chat',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        provider_marker: responseMarker,
      }),
    );
    const response = await setup(fetcher).request(
      path,
      { method: 'POST', headers: headers(), body: JSON.stringify(body()) },
      testEnv,
    );
    expect(response.status).toBe(503);
    const result = await response.json();
    expect(result.error.details.diagnostic).toMatchObject({
      execution: 'response_received',
      request: { method: 'POST', publicModelId: 'g20-model', upstreamModel: 'upstream-chat' },
      response: { status: 200, body: expect.stringContaining(responseMarker), complete: true },
      failure: { source: 'cheapai', phase: 'audit' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const audit = JSON.stringify(await actions());
    expect(audit).toContain('channel.test.intent');
    expect(audit).not.toContain(responseMarker);
    expect(audit).not.toContain(credential);
    expect(
      (await prepare(testEnv.DB, 'SELECT count(*) AS n FROM billing_entries').first())?.n,
    ).toBe(0);
    expect((await prepare(testEnv.DB, 'SELECT count(*) AS n FROM requests').first())?.n).toBe(0);
  });

  it('keeps pre-dispatch configuration failure when the result audit also fails', async () => {
    await prepare(
      testEnv.DB,
      "UPDATE channels SET base_url='ftp://provider.example.com' WHERE id='g20-channel'",
    ).run();
    await prepare(
      testEnv.DB,
      "CREATE TRIGGER g20_no_transport_result BEFORE INSERT ON admin_audit WHEN NEW.action LIKE 'channel.test.transport_error%' BEGIN SELECT RAISE(ABORT,'test audit failure'); END",
    ).run();
    const fetcher = vi.fn(async () => chatReply());
    const response = await setup(fetcher).request(
      path,
      { method: 'POST', headers: headers(), body: JSON.stringify(body()) },
      testEnv,
    );
    expect(response.status).toBe(503);
    const result = await response.json();
    const evidence = result.error.details.diagnostic;
    expect(evidence).toMatchObject({
      execution: 'not_started',
      request: null,
      response: null,
      failure: { source: 'cheapai', phase: 'audit' },
    });
    expect(evidence.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'audit_intent', state: 'completed' }),
        expect.objectContaining({ name: 'audit_result', state: 'failed' }),
      ]),
    );
    expect(evidence.phases).not.toContainEqual(
      expect.objectContaining({ name: 'audit_intent', state: 'failed' }),
    );
    expect(evidence.failure.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '$.failure.configuration',
          message: expect.stringContaining('invalid_configuration'),
        }),
      ]),
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect((await actions()).map((row) => row.action)).toEqual(['channel.test.intent']);
  });

  it('keeps a dispatched timeout without claiming a response when the result audit fails', async () => {
    await prepare(
      testEnv.DB,
      "CREATE TRIGGER g20_no_timeout_result BEFORE INSERT ON admin_audit WHEN NEW.action LIKE 'channel.test.timeout%' BEGIN SELECT RAISE(ABORT,'test audit failure'); END",
    ).run();
    const fetcher = vi.fn(async () => new Promise<Response>(() => undefined));
    const app = createTestChannelRoutes({
      now: () => now,
      trustedOrigin: origin,
      fetch: fetcher,
      timeoutMs: 50,
    });
    const response = await app.request(
      path,
      { method: 'POST', headers: headers(), body: JSON.stringify(body()) },
      testEnv,
    );
    expect(response.status).toBe(503);
    const result = await response.json();
    const evidence = result.error.details.diagnostic;
    expect(evidence).toMatchObject({
      execution: 'attempted',
      request: { method: 'POST' },
      response: null,
      failure: { source: 'cheapai', phase: 'audit' },
    });
    expect(evidence.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'audit_intent', state: 'completed' }),
        expect.objectContaining({ name: 'audit_result', state: 'failed' }),
      ]),
    );
    expect(evidence.failure.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '$.failure.headers',
          message: expect.stringContaining('request_timeout'),
        }),
      ]),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await actions()).map((row) => row.action)).toEqual(['channel.test.intent']);
  });
});
