import { parseRpmLimit, parseChannelLimits, UNLIMITED_RPM } from '../../apps/worker/config';
import { consumeRateWindow } from '../../apps/worker/limits/rate-window';
import { updateUser } from '../../apps/worker/admin/update-user';
import { updateChannel } from '../../apps/worker/admin/channel-repository';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { admitRequest, GatewayAdmissionError } from '../../apps/worker/gateway/admit';
import { authenticatePlatformKey } from '../../apps/worker/auth/api-key-auth';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import type { InternalPlatformKeyAuth } from '../../apps/worker/auth/key-repository';
import type { LeaseBinding } from '../../apps/worker/limits/client';
import { LeaseStorage } from '../../apps/worker/limits/storage';
import { readRoutes } from '../../apps/worker/cache/routes';
import { createPriceSnapshot, readPriceSnapshot } from '../../apps/worker/billing/fingerprint';
import { commitRequestRegistration, finishRequest, prepareRequestRegistration } from '../../apps/worker/gateway/request-repository';
import { responseIdForRequest } from '../../apps/worker/gateway/response-history';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';
import type { ProtocolRequest } from '../../packages/apicompat/capabilities/check';

let now: number;
let subject: InternalPlatformKeyAuth;
const request: ProtocolRequest = { protocol: 'chat', request: { model: 'g03-model', messages: [{ role: 'user', content: 'synthetic prompt never stored' }], max_tokens: 20 } };
const options = () => ({ now: () => now, adapterAvailable: () => true });
const count = async () => (await prepare(testEnv.DB, 'SELECT count(*) AS n FROM requests').first())?.n;
const active = (name: string) => runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName(name)), (_instance, context) => new LeaseStorage(context.storage).read(now).leases.length);

function mutateAfterChannelAcquire(mutate: () => Promise<void>): LeaseBinding {
  const names = new Map<string, string>();
  return {
    idFromName(name) { const id = testEnv.GATE.idFromName(name); names.set(id.toString(), name); return id; },
    get(id) {
      const native = testEnv.GATE.get(id);
      return {
        async acquire(input) {
          const result = await native.acquire(input);
          if (names.get(id.toString())?.startsWith('channel:')) await mutate();
          return result;
        },
        renew: input => native.renew(input), release: input => native.release(input),
      };
    },
  };
}

beforeEach(async () => {
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await prepare(testEnv.DB, "INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('g03-group','G03 Group','active',1,0,0)").run();
  await prepare(testEnv.DB, `INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('g03-user','g03@example.invalid','test-only-hash','user','active','g03-group',100,1,60,'admin',0,0)`).run();
  const token = generateToken('apiKey');
  await prepare(testEnv.DB, `INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
    VALUES('g03-key','g03-user',?,'s2a_key_ABCDEFGH','G03 Key','active',0,0)`, [await hashToken('apiKey', token)]).run();
  const ciphertext = JSON.stringify({ algorithm: 'A256GCM', format_version: 1, key_version: 'test', nonce: 'synthetic', ciphertext: 'synthetic-only' });
  await prepare(testEnv.DB, `INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('g03-channel','G03 Channel','https://provider.example.com',?,'test','active',1,2,60,1,0,0)`, [ciphertext]).run();
  await prepare(testEnv.DB, `INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('g03-model','active',?,1,10,4096,0,0)`, [JSON.stringify({ input: '1', output: '2' })]).run();
  await prepare(testEnv.DB, "INSERT INTO channel_groups(channel_id,group_id) VALUES('g03-channel','g03-group')").run();
  await prepare(testEnv.DB, `INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version)
    VALUES('g03-channel','g03-model','chat','provider-model',?,1)`, [JSON.stringify({ protocol: 'chat', features: [], maxOutputTokens: 4096 })]).run();
  subject = await authenticatePlatformKey(testEnv.DB, new Request('https://gateway.example/v1/chat/completions', { headers: { Authorization: `Bearer ${token}` } }), now);
});
afterEach(() => vi.restoreAllMocks());

describe('final gateway admission with native D1 and Gate leases', () => {
  it('admits more than sixty requests in one minute when both business limits are unlimited', async () => {
    await prepare(testEnv.DB, 'UPDATE users SET concurrency_limit=?,rpm_limit=? WHERE id=?', [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, subject.user.id]).run();
    await prepare(testEnv.DB, 'UPDATE channels SET concurrency_limit=?,rpm_limit=?', [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]).run();
    subject = { ...subject, user: { ...subject.user, concurrencyLimit: Number.MAX_SAFE_INTEGER, rpmLimit: Number.MAX_SAFE_INTEGER } };
    const held: Awaited<ReturnType<typeof admitRequest>>[] = [];
    try {
      for (let index = 0; index < 65; index++) held.push(await admitRequest(testEnv, subject, request, options()));
      expect(await active('user:g03-user')).toBe(65);
      expect(await active('channel:g03-channel')).toBe(65);
    } finally { for (const admitted of held) expect((await admitted.lease.release()).complete).toBe(true); }
    expect(await count()).toBe(65);
    expect(await active('user:g03-user')).toBe(0);
    expect(await active('channel:g03-channel')).toBe(0);
  }, 20000);
  it('holds both leases under the registered UUID before returning a sendable request', async () => {
    const admitted = await admitRequest(testEnv, subject, request, options());
    try {
      expect(admitted.request.execution_status).toBe('admitted');
      expect(admitted.lease.user.handle.requestId).toBe(admitted.request.id);
      expect(admitted.lease.channel.handle.requestId).toBe(admitted.request.id);
      expect(admitted.outputTokenLimit).toBe(20);
      expect(readPriceSnapshot(admitted.request.price_snapshot).snapshot).toMatchObject({ public_model_id: 'g03-model', upstream_model: 'provider-model', price_version: 1 });
      expect(await active('user:g03-user')).toBe(1);
      expect(await active('channel:g03-channel')).toBe(1);
      expect(await count()).toBe(1);
      expect(JSON.stringify(admitted.request)).not.toMatch(/synthetic prompt|key_hash|password|ciphertext/);
    } finally { expect((await admitted.lease.release()).complete).toBe(true); }
  });

  it('denies insufficient authoritative balance before acquiring leases', async () => {
    await prepare(testEnv.DB, "UPDATE users SET balance_units=0 WHERE id='g03-user'").run();
    await expect(admitRequest(testEnv, subject, request, options())).rejects.toMatchObject({ code: 'insufficient_balance' });
    expect(await active('user:g03-user')).toBe(0);
    expect(await count()).toBe(0);
  });

  it.each([
    "UPDATE channels SET config_version=2 WHERE id='g03-channel'",
    "UPDATE channel_models SET config_version=2 WHERE channel_id='g03-channel'",
    "UPDATE models SET price_version=2 WHERE public_model_id='g03-model'",
    "UPDATE api_keys SET status='revoked' WHERE id='g03-key'",
    "UPDATE users SET balance_units=0 WHERE id='g03-user'",
    "DELETE FROM channel_groups WHERE group_id='g03-group'",
  ])('does not register if authority changes while leases are acquired %#', async sql => {
    const gate = mutateAfterChannelAcquire(async () => { await prepare(testEnv.DB, sql).run(); });
    await expect(admitRequest({ ...testEnv, GATE: gate }, subject, request, options())).rejects.toMatchObject({ code: 'conflict', cleanup: { complete: true } });
    expect(await count()).toBe(0);
    expect(await active('user:g03-user')).toBe(0);
    expect(await active('channel:g03-channel')).toBe(0);
  });

  it('rechecks exact key expiry after the asynchronous lease wait', async () => {
    await prepare(testEnv.DB, 'UPDATE api_keys SET expires_at=?', [now + 1]).run();
    const gate = mutateAfterChannelAcquire(async () => { now++; });
    await expect(admitRequest({ ...testEnv, GATE: gate }, subject, request, options())).rejects.toMatchObject({ code: 'conflict' });
    expect(await count()).toBe(0);
    expect(await active('user:g03-user')).toBe(0);
  });

  it('releases leases on a D1 commit failure without returning send permission', async () => {
    const database = new Proxy(testEnv.DB, { get(target, property) {
      if (property === 'batch') return async () => { throw new Error('synthetic commit failure'); };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(admitRequest({ ...testEnv, DB: database }, subject, request, options())).rejects.toBeInstanceOf(GatewayAdmissionError);
    expect(await count()).toBe(0);
    expect(await active('user:g03-user')).toBe(0);
    expect(await active('channel:g03-channel')).toBe(0);
  });

  it('returns a lease denial without creating a second request', async () => {
    const first = await admitRequest(testEnv, subject, request, options());
    try {
      await expect(admitRequest(testEnv, subject, request, options())).rejects.toMatchObject({ code: 'rate_limited', cleanup: { complete: true } });
      expect(await count()).toBe(1);
    } finally { await first.lease.release(); }
  });

  it('exposes a reviewed unregistered channel denial for explicit candidate exclusion', async () => {
    await testEnv.DB.prepare("UPDATE channels SET concurrency_limit=1 WHERE id='g03-channel'").run();
    const gate = testEnv.GATE.get(testEnv.GATE.idFromName('channel:g03-channel'));
    const occupied = await gate.acquire({ requestId: 'busy-fixture', limit: 1, ttlMs: 90000 });
    if (!occupied.granted) throw new Error('Expected fixture lease');
    try {
      await expect(admitRequest(testEnv, subject, request, options())).rejects.toMatchObject({ code: 'rate_limited',
        candidate: { channelId: 'g03-channel', protocol: 'chat' }, registeredRequestId: null, candidateFailure: 'busy', cleanup: { complete: true } });
      expect(await count()).toBe(0);
    } finally { await gate.release({ requestId: 'busy-fixture', leaseToken: occupied.lease.leaseToken }); }
  });

  it('enforces trusted Chat stream usage policy before registering even if the client opts out', async () => {
    const streaming: ProtocolRequest = { protocol: 'chat', request: { ...request.request, stream: true, stream_options: { include_usage: false } } };
    await testEnv.DB.prepare("UPDATE channel_models SET capabilities_json=? WHERE channel_id='g03-channel'").bind(JSON.stringify({ protocol: 'chat', features: ['streaming'], maxOutputTokens: 4096 })).run();
    await expect(admitRequest(testEnv, subject, streaming, { ...options(), requireChatStreamUsage: true })).rejects.toBeInstanceOf(Error);
    expect(await count()).toBe(0);
  });

  it('does not return send permission after a committed INSERT loses its acknowledgement', async () => {
    const database = new Proxy(testEnv.DB, { get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        await target.batch(statements);
        throw new Error('synthetic lost acknowledgement');
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(admitRequest({ ...testEnv, DB: database }, subject, request, options())).rejects.toMatchObject({ code: 'service_unavailable', cleanup: { complete: true }, candidate: { channelId: 'g03-channel' }, registeredRequestId: expect.any(String) });
    expect(await count()).toBe(1);
    expect(await active('user:g03-user')).toBe(0);
    expect(await active('channel:g03-channel')).toBe(0);
  });

  it('reloads stale routing versions once and persists the current price snapshot', async () => {
    await readRoutes(testEnv.DB, testEnv.CACHE, subject.group.id, 'g03-model', { now: () => now });
    await prepare(testEnv.DB, "UPDATE models SET price_version=2 WHERE public_model_id='g03-model'").run();
    const admitted = await admitRequest(testEnv, subject, request, options());
    try { expect(readPriceSnapshot(admitted.request.price_snapshot).snapshot.price_version).toBe(2); }
    finally { await admitted.lease.release(); }
  });

  it('fails before leases when adapter availability is unproven or request is cancelled', async () => {
    await expect(admitRequest(testEnv, subject, request, { now: () => now })).rejects.toMatchObject({ code: 'service_unavailable' });
    const controller = new AbortController(); controller.abort();
    await expect(admitRequest(testEnv, subject, request, { ...options(), signal: controller.signal })).rejects.toMatchObject({ code: 'conflict' });
    expect(await count()).toBe(0);
    expect(await active('user:g03-user')).toBe(0);
  });
});

async function addAlternative(protocol: 'chat' | 'responses') {
  await prepare(testEnv.DB, `INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    SELECT 'g03-alternative','G03 Alternative',base_url,secret_ciphertext,secret_key_version,status,100,concurrency_limit,rpm_limit,1,0,0
    FROM channels WHERE id='g03-channel'`).run();
  await prepare(testEnv.DB, "INSERT INTO channel_groups(channel_id,group_id) VALUES('g03-alternative','g03-group')").run();
  await prepare(testEnv.DB, `INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version)
    VALUES('g03-alternative','g03-model',?,'provider-model',?,1)`, [protocol, JSON.stringify({ protocol, features: protocol === 'responses' ? ['response_history'] : [], maxOutputTokens: 4096 })]).run();
}
async function nativeHistoryRequest(): Promise<ProtocolRequest> {
  await prepare(testEnv.DB, `INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version)
    VALUES('g03-channel','g03-model','responses','provider-model',?,1)`, [JSON.stringify({ protocol: 'responses', features: ['response_history'], maxOutputTokens: 4096 })]).run();
  const original = await commitRequestRegistration(testEnv.DB, prepareRequestRegistration(testEnv.DB, {
    userId: subject.user.id, keyId: subject.key.id, groupId: subject.group.id, channelId: 'g03-channel', downstreamProtocol: 'responses', now,
    versions: { user: 1, key: 1, group: 1, channel: 1, mapping: 1 },
    priceSnapshotJson: createPriceSnapshot({ publicModelId: 'g03-model', upstreamModel: 'provider-model', upstreamProtocol: 'responses', priceVersion: 1,
      sellPrices: { input: '1', output: '2' } }).json,
  }));
  await finishRequest(testEnv.DB, original.id, subject.user.id, { status: 'succeeded', responseId: 'native-g03-history' }, now);
  return { protocol: 'responses', request: { model: 'g03-model', previous_response_id: responseIdForRequest(original.id), input: 'continue', max_output_tokens: 20 } };
}

describe('G03 history constraints and retry exclusions', () => {
  it('uses the original history channel instead of a higher-priority alternative and restores upstream ID', async () => {
    const continuation = await nativeHistoryRequest();
    await addAlternative('responses');
    const admitted = await admitRequest(testEnv, subject, continuation, { ...options(), validateRequiredChecks: async () => true });
    try {
      expect(admitted.selected.candidate.channel.id).toBe('g03-channel');
      expect(admitted.historyBinding?.upstreamResponseId).toBe('native-g03-history');
      expect(admitted.requestForAdapter.request.previous_response_id).toBe('native-g03-history');
      expect(continuation.request.previous_response_id).not.toBe('native-g03-history');
    } finally { await admitted.lease.release(); }
  });

  it('does not bypass history binding when its channel is excluded or disabled', async () => {
    const continuation = await nativeHistoryRequest();
    await addAlternative('responses');
    await expect(admitRequest(testEnv, subject, continuation, { ...options(), excludeCandidates: [{ channelId: 'g03-channel' }] }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await prepare(testEnv.DB, "UPDATE channels SET status='disabled' WHERE id='g03-channel'").run();
    await expect(admitRequest(testEnv, subject, continuation, options())).rejects.toMatchObject({ code: 'conflict' });
    expect(await count()).toBe(1);
    expect(await active('channel:g03-alternative')).toBe(0);
  });

  it('chooses a different candidate deterministically after a retry owner excludes the previous one', async () => {
    await addAlternative('chat');
    const first = await admitRequest(testEnv, subject, request, options());
    const tried = first.selected.candidate;
    expect(tried.channel.id).toBe('g03-alternative');
    await first.lease.release();
    const next = await admitRequest(testEnv, subject, request, { ...options(), excludeCandidates: [{ channelId: tried.channel.id, protocol: tried.mapping.protocol }] });
    try { expect(next.selected.candidate.channel.id).toBe('g03-channel'); }
    finally { await next.lease.release(); }
  });
});

describe('BV02 finite RPM configuration and identity boundaries', () => {
  it.each([1, 4096])('accepts finite %s consistently in config, admin writes and Gate admission', async limit => {
    expect(parseRpmLimit(limit)).toBe(limit);
    expect(parseChannelLimits({ rpmLimit: limit }).rpmLimit).toBe(limit);
    expect(consumeRateWindow(null, { now, windowMs: 60000, limit, operationId: 'finite-operation' }).allowed).toBe(true);
    await prepare(testEnv.DB, "UPDATE users SET role='admin' WHERE id='g03-user'").run();
    const user = await updateUser(testEnv.DB, 'g03-user', 1, { rpmLimit: limit }, { actorId: 'g03-user', operationId: 'rpm-user-update', now });
    const channel = await updateChannel(testEnv.DB, 'g03-channel', 1, { rpmLimit: limit }, { actorId: 'g03-user', operationId: 'rpm-channel-update', now });
    expect(user.rpm_limit).toBe(limit); expect(channel.rpmLimit).toBe(limit);
    subject = { ...subject, user: { ...subject.user, version: user.version, rpmLimit: limit } };
    const admitted = await admitRequest(testEnv, subject, request, options());
    expect(admitted.lease.user.handle.requestId).toBe(admitted.request.id);
    expect((await admitted.lease.release()).complete).toBe(true);
  });
  it.each([4097, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsupported finite %s at both admin entry points', async limit => {
    expect(() => parseRpmLimit(limit)).toThrow();
    expect(() => parseChannelLimits({ rpmLimit: limit })).toThrow();
    expect(() => consumeRateWindow(null, { now, windowMs: 60000, limit, operationId: 'invalid-operation' })).toThrow();
    await expect(updateUser(testEnv.DB, 'g03-user', 1, { rpmLimit: limit }, { actorId: 'g03-user', operationId: 'bad-user-rpm', now })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(updateChannel(testEnv.DB, 'g03-channel', 1, { rpmLimit: limit }, { actorId: 'g03-user', operationId: 'bad-channel-rpm', now })).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it.each([undefined, null, 0, UNLIMITED_RPM])('preserves unlimited config form %#', value => {
    expect(parseRpmLimit(value)).toBe(UNLIMITED_RPM);
    expect(parseChannelLimits({ rpmLimit: value }).rpmLimit).toBe(UNLIMITED_RPM);
  });
  it.each(['user', 'channel'])('refuses stored over-limit %s RPM without registering a request', async kind => {
    if (kind === 'user') {
      await prepare(testEnv.DB, 'UPDATE users SET rpm_limit=4097').run();
      subject = { ...subject, user: { ...subject.user, rpmLimit: 4097 } };
    } else await prepare(testEnv.DB, 'UPDATE channels SET rpm_limit=4097').run();
    await expect(admitRequest(testEnv, subject, request, options())).rejects.toBeInstanceOf(Error);
    expect(await count()).toBe(0); expect(await active('user:g03-user')).toBe(0);
  });
  it.each(['', 'bad id', 'x'.repeat(129)])('rejects invalid internal logical RPM identity %#', async userRateOperationId => {
    await expect(admitRequest(testEnv, subject, request, { ...options(), userRateOperationId })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await count()).toBe(0);
  });
});

describe('BV02 ambiguous acquisition recovery identity', () => {
  it('recovers and releases using the original lease ID and logical rate parameters', async () => {
    const calls: Parameters<ReturnType<LeaseBinding['get']>['acquire']>[0][] = [];
    const names = new Map<string, string>();
    let failed = false;
    const gate: LeaseBinding = {
      idFromName(name) { const id = testEnv.GATE.idFromName(name); names.set(id.toString(), name); return id; },
      get(id) {
        const native = testEnv.GATE.get(id);
        return {
          async acquire(input) {
            if (names.get(id.toString()) === 'user:g03-user') calls.push(structuredClone(input));
            const result = await native.acquire(input);
            if (!failed) {
              failed = true;
              const dispose = (result as unknown as Record<symbol, unknown>)[(Symbol as SymbolConstructor & { readonly dispose: symbol }).dispose];
              if (typeof dispose === 'function') dispose.call(result);
              throw new Error('Lost acquisition acknowledgement');
            }
            return result;
          },
          renew: input => native.renew(input), release: input => native.release(input),
        };
      },
    };
    await expect(admitRequest({ ...testEnv, GATE: gate }, subject, request, { ...options(), userRateOperationId: 'logical-recovery-operation' }))
      .rejects.toMatchObject({ cleanup: { complete: true } });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[0]?.rate?.operationId).toBe('logical-recovery-operation');
    expect(calls[0]?.requestId).not.toBe('logical-recovery-operation');
    expect(await active('user:g03-user')).toBe(0); expect(await count()).toBe(0);
  });
});
