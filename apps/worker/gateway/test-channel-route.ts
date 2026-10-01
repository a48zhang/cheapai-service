import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Protocol } from '@sub2api/apicompat/types/shared';
import { parseChatResponse } from '@sub2api/apicompat/types/chat';
import { parseMessagesResponse } from '@sub2api/apicompat/types/messages';
import { responsesResponseAdapter } from '@sub2api/apicompat/passthrough/responses';
import { createResponseIds } from '@sub2api/apicompat/ids';
import { requireSession } from '../auth/middleware';
import type { AuthVariables } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { validateCsrfRequest } from '../auth/csrf';
import { getChannelById, readChannelForForwarding } from '../admin/channel-repository';
import type { ChannelKeyring } from '../admin/channel-secrets';
import { getModelById } from '../admin/model-repository';
import { getModelMapping } from '../admin/model-mappings';
import { buildAuditStatement } from '../admin/audit';
import { batch, prepare } from '../db';
import { ApiError, apiError, apiSuccess, createRequestId } from '../http';
import { readGatewayJson } from './read-json';
import { sendUpstream, UpstreamTransportError } from './transport';
import type { UpstreamExchange, UpstreamFetch } from './transport';

export const TEST_CHANNEL_PATH = '/api/v1/admin/channels/:id/test';
export const PROBE_MAX_OUTPUT_TOKENS = 16;
const MAX_RESPONSE_BYTES = 32_768;
type Bindings = { DB: D1Database };
type RouteEnv<B extends Bindings> = { Bindings: B; Variables: AuthVariables };
type Resolver<B, T> = T | ((env: B, request: Request) => T | Promise<T>);
export interface TestChannelDependencies<B extends Bindings = Bindings> {
  now?: () => number;
  trustedOrigin?: Resolver<B, string>;
  keyring?: Resolver<B, ChannelKeyring>;
  fetch?: UpstreamFetch;
  /** Trusted server test policy; cannot exceed ten seconds. */
  timeoutMs?: number;
}
interface ProbeInput { publicModelId: string; protocol: Protocol; channelVersion: number; mappingVersion: number; priceVersion: number }
type Outcome = 'responded' | 'http_error' | 'invalid_response' | 'timeout' | 'cancelled' | 'transport_error';
async function resolve<B, T>(value: Resolver<B, T> | undefined, env: B, request: Request): Promise<T> {
  const result = typeof value === 'function' ? await (value as (env: B, request: Request) => T | Promise<T>)(env, request) : value;
  if (result === undefined) throw new ApiError('service_unavailable');
  return result;
}
function input(value: unknown): ProbeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid_request');
  const fields = value as Record<string, unknown>;
  const allowed = ['publicModelId', 'protocol', 'channelVersion', 'mappingVersion', 'priceVersion'];
  if (Object.keys(fields).length !== allowed.length || !allowed.every(field => Object.hasOwn(fields, field)) ||
      typeof fields.publicModelId !== 'string' || fields.publicModelId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(fields.publicModelId) ||
      !['chat', 'responses', 'messages'].includes(fields.protocol as string) ||
      ![fields.channelVersion, fields.mappingVersion, fields.priceVersion].every(version => typeof version === 'number' && Number.isSafeInteger(version) && version >= 1)) throw new ApiError('invalid_request');
  return fields as unknown as ProbeInput;
}
async function validResponse(response: Response, protocol: Protocol, diagnosticId: string, model: string): Promise<boolean> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !response.body) return false;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      total += part.value.byteLength; if (total > MAX_RESPONSE_BYTES) return false;
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (protocol === 'chat') return parseChatResponse(value, { unknownFields: 'preserve' }).ok;
    if (protocol === 'messages') return parseMessagesResponse(value, { unknownFields: 'preserve' }).ok;
    const ids = createResponseIds({ seed: diagnosticId });
    return ids.ok && responsesResponseAdapter.convert(value, { identity: ids.value.identity, idFor: ids.value.idFor, targetModel: model, createdAt: 0 }).ok;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Explicit administrator action only. No request ledger/zero-cost billing entry
 * is fabricated: this probe may consume upstream account credit independently.
 */
export function createTestChannelRoutes<B extends Bindings = Bindings>(dependencies: TestChannelDependencies<B>): Hono<RouteEnv<B>> {
  const app = new Hono<RouteEnv<B>>();
  const now = dependencies.now ?? Date.now;
  app.use(TEST_CHANNEL_PATH, async (context, next) => {
    context.set('requestId', context.get('requestId') ?? createRequestId());
    await next(); context.header('Cache-Control', 'no-store');
  });
  app.onError((error, context) => apiError(error instanceof ApiError ? error : new ApiError('service_unavailable'), context.get('requestId') ?? createRequestId()));
  app.use(TEST_CHANNEL_PATH, (context, next) => {
    const authenticate: MiddlewareHandler = requireSession(now);
    return authenticate(context, next);
  });
  app.use(TEST_CHANNEL_PATH, requireAdmin);
  app.post(TEST_CHANNEL_PATH, async context => {
    validateCsrfRequest(context.req.raw, await resolve(dependencies.trustedOrigin, context.env, context.req.raw));
    const body = input(await readGatewayJson(context.req.raw, 4096));
    const channelId = context.req.param('id');
    const [channel, model, mapping] = await Promise.all([
      getChannelById(context.env.DB, channelId), getModelById(context.env.DB, body.publicModelId),
      getModelMapping(context.env.DB, { channelId, publicModelId: body.publicModelId, protocol: body.protocol }),
    ]);
    if (!channel || !model || !mapping) throw new ApiError('not_found');
    if (channel.status !== 'active' || model.status !== 'active' || channel.configVersion !== body.channelVersion ||
        model.priceVersion !== body.priceVersion || mapping.configVersion !== body.mappingVersion) throw new ApiError('conflict');
    const keyring = await resolve(dependencies.keyring, context.env, context.req.raw);
    const forwarding = await readChannelForForwarding(context.env.DB, channelId, keyring);
    if (!forwarding || forwarding.status !== 'active' || forwarding.configVersion !== channel.configVersion) throw new ApiError('conflict');
    const timeoutMs = dependencies.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new ApiError('service_unavailable');
    const outputLimit = Math.min(PROBE_MAX_OUTPUT_TOKENS, model.maxOutputTokens, mapping.capabilities.maxOutputTokens ?? PROBE_MAX_OUTPUT_TOKENS);
    const diagnosticId = crypto.randomUUID();
    const actorId = context.get('user').id;
    const audit = (action: string) => buildAuditStatement(context.env.DB, {
      actor_id: actorId, action, target_type: 'channel', target_id: channelId, operation_id: diagnosticId, created_at: now(),
      changes: { channel_id: channelId, public_model_id: body.publicModelId, protocol: body.protocol, config_version: channel.configVersion,
        version: mapping.configVersion, price_version: model.priceVersion, max_output_tokens: outputLimit, quantity: 1 },
    });
    try {
      await batch(context.env.DB, [prepare(context.env.DB, `SELECT CASE WHEN EXISTS(
        SELECT 1 FROM users u JOIN groups g ON g.id=u.group_id JOIN sessions s ON s.user_id=u.id
        JOIN channels c ON c.id=? JOIN channel_models cm ON cm.channel_id=c.id
        JOIN models m ON m.public_model_id=cm.public_model_id
        WHERE u.id=? AND u.role='admin' AND u.status='active' AND g.status='active'
          AND s.id=? AND s.revoked_at IS NULL AND s.expires_at>?
          AND c.status='active' AND c.config_version=? AND m.status='active' AND m.public_model_id=? AND m.price_version=?
          AND cm.protocol=? AND cm.config_version=? AND cm.upstream_model=?
        ) THEN 1 ELSE json_extract('{}','channel_probe_conflict') END`,
      [channelId, actorId, context.get('session').id, now(), channel.configVersion, body.publicModelId, model.priceVersion,
        body.protocol, mapping.configVersion, mapping.upstreamModel]), audit('channel.test.intent')]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('channel_probe_conflict')) throw new ApiError('conflict');
      throw new ApiError('service_unavailable');
    }
    const requestBody = body.protocol === 'responses'
      ? { model: mapping.upstreamModel, input: 'Reply OK.', max_output_tokens: outputLimit, stream: false }
      : { model: mapping.upstreamModel, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: outputLimit, stream: false };
    let exchange: UpstreamExchange | undefined;
    let upstreamStatus: number | null = null;
    let outcome: Outcome = 'transport_error';
    try {
      exchange = await sendUpstream({ baseUrl: forwarding.baseUrl, upstreamProtocol: body.protocol, upstreamKey: forwarding.upstreamKey,
        body: JSON.stringify(requestBody), stream: false, signal: context.req.raw.signal,
        maxDurationMs: timeoutMs, headersTimeoutMs: Math.min(3000, timeoutMs), idleTimeoutMs: Math.min(3000, timeoutMs) },
      dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch });
      upstreamStatus = exchange.response.status;
      outcome = !exchange.response.ok ? 'http_error' : await validResponse(exchange.response, body.protocol, diagnosticId, body.publicModelId) ? 'responded' : 'invalid_response';
    } catch (error) {
      outcome = error instanceof UpstreamTransportError && error.reason.endsWith('_timeout') ? 'timeout'
        : error instanceof UpstreamTransportError && error.reason === 'cancelled' ? 'cancelled'
        : error instanceof SyntaxError ? 'invalid_response' : 'transport_error';
    } finally { exchange?.cancel(); }
    // Status is in a controlled action token; no provider error/body/secret enters audit.
    try { await audit(`channel.test.${outcome}${upstreamStatus === null ? '' : `.${upstreamStatus}`}`).run(); }
    catch { throw new ApiError('service_unavailable'); }
    return apiSuccess({ diagnosticId, channelId, publicModelId: body.publicModelId, protocol: body.protocol, outcome, upstreamStatus,
      channelVersion: channel.configVersion, mappingVersion: mapping.configVersion, priceVersion: model.priceVersion,
      maxOutputTokens: outputLimit, mayIncurUpstreamCost: true, userBalanceCharged: false }, context.get('requestId'));
  });
  return app;
}
