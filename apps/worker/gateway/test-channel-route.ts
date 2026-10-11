import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Protocol } from '@sub2api/apicompat/types/shared';
import { requireSession } from '../auth/middleware';
import type { AuthVariables } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { validateCsrfRequest } from '../auth/csrf';
import { getChannelById, readChannelForForwarding } from '../catalog/channels';
import { getModelById } from '../catalog/models';
import { getModelMapping } from '../catalog/model-mappings';
import { buildAuditStatement } from '../admin/audit';
import { batch, prepare } from '../db';
import { ApiError, apiSuccess, createRequestId } from '../http';
import type { ProbeEvidence } from '@cheapai/contracts/channel-diagnostics';
import { ChannelDiagnosticApiError, channelDiagnosticApiError } from './diagnostic-errors';
import { redactDiagnosticEvidence } from './diagnostic-redaction';
import { readGatewayJson } from './read-json';
import { CHANNEL_PROBE_MAX_OUTPUT_TOKENS } from '@cheapai/contracts/channel-probe';
import { runChannelDiagnostic } from './channel-probe';
import type { UpstreamFetch } from './transport';

export const TEST_CHANNEL_PATH = '/api/v1/admin/channels/:id/test';
export const PROBE_MAX_OUTPUT_TOKENS = CHANNEL_PROBE_MAX_OUTPUT_TOKENS;
type Bindings = { DB: D1Database };
type RouteEnv<B extends Bindings> = { Bindings: B; Variables: AuthVariables };
type Resolver<B, T> = T | ((env: B, request: Request) => T | Promise<T>);
export interface TestChannelDependencies<B extends Bindings = Bindings> {
  now?: () => number;
  trustedOrigin?: Resolver<B, string>;
  fetch?: UpstreamFetch;
  /** Trusted server test policy; cannot exceed ten seconds. */
  timeoutMs?: number;
}
interface ProbeInput {
  publicModelId: string;
  protocol: Protocol;
  channelVersion: number;
  mappingVersion: number;
  priceVersion: number;
}
async function resolve<B, T>(
  value: Resolver<B, T> | undefined,
  env: B,
  request: Request,
): Promise<T> {
  const result =
    typeof value === 'function'
      ? await (value as (env: B, request: Request) => T | Promise<T>)(env, request)
      : value;
  if (result === undefined) throw new ApiError('service_unavailable');
  return result;
}
function input(value: unknown): ProbeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError('invalid_request');
  const fields = value as Record<string, unknown>;
  const allowed = ['publicModelId', 'protocol', 'channelVersion', 'mappingVersion', 'priceVersion'];
  if (
    Object.keys(fields).length !== allowed.length ||
    !allowed.every((field) => Object.hasOwn(fields, field)) ||
    typeof fields.publicModelId !== 'string' ||
    fields.publicModelId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(fields.publicModelId) ||
    !['chat', 'responses', 'messages'].includes(fields.protocol as string) ||
    ![fields.channelVersion, fields.mappingVersion, fields.priceVersion].every(
      (version) => typeof version === 'number' && Number.isSafeInteger(version) && version >= 1,
    )
  )
    throw new ApiError('invalid_request');
  return fields as unknown as ProbeInput;
}
/** Explicit administrator action only. No request ledger/zero-cost billing entry
 * is fabricated: this probe may consume upstream account credit independently.
 */
export function createTestChannelRoutes<B extends Bindings = Bindings>(
  dependencies: TestChannelDependencies<B>,
): Hono<RouteEnv<B>> {
  const app = new Hono<RouteEnv<B>>();
  const now = dependencies.now ?? Date.now;
  app.use(TEST_CHANNEL_PATH, async (context, next) => {
    context.set('requestId', context.get('requestId') ?? createRequestId());
    await next();
    context.header('Cache-Control', 'no-store');
  });
  app.onError((error, context) =>
    channelDiagnosticApiError(
      error instanceof ApiError ? error : new ApiError('service_unavailable'),
      context.get('requestId') ?? createRequestId(),
    ),
  );
  app.use(TEST_CHANNEL_PATH, (context, next) => {
    const authenticate: MiddlewareHandler = requireSession(now);
    return authenticate(context, next);
  });
  app.use(TEST_CHANNEL_PATH, requireAdmin);
  app.post(TEST_CHANNEL_PATH, async (context) => {
    validateCsrfRequest(
      context.req.raw,
      await resolve(dependencies.trustedOrigin, context.env, context.req.raw),
    );
    const body = input(await readGatewayJson(context.req.raw, 4096));
    const channelId = context.req.param('id');
    const diagnosticId = crypto.randomUUID();
    const startedAt = now();
    let phaseStartedAt = startedAt;
    let phase: 'configuration' | 'audit_intent' | 'dispatch' | 'audit_result' = 'configuration';
    let upstreamKey: string | undefined;
    let configurationCode: string | null = null;
    let configurationMessage: string | null = null;
    let evidence: ProbeEvidence = {
      requestId: context.get('requestId'),
      startedAt,
      durationMs: 0,
      execution: 'not_started',
      request: null,
      redirects: [],
      response: null,
      failure: null,
      phases: [],
    };
    const elapsed = (since: number) => Math.max(0, now() - since);
    try {
      const [channel, model, mapping] = await Promise.all([
        getChannelById(context.env.DB, channelId),
        getModelById(context.env.DB, body.publicModelId),
        getModelMapping(context.env.DB, {
          channelId,
          publicModelId: body.publicModelId,
          protocol: body.protocol,
        }),
      ]);
      if (!channel || !model || !mapping) throw new ApiError('not_found');
      if (
        channel.status !== 'active' ||
        model.status !== 'active' ||
        channel.configVersion !== body.channelVersion ||
        model.priceVersion !== body.priceVersion ||
        mapping.configVersion !== body.mappingVersion
      )
        throw new ApiError('conflict');
      if (!channel.hasCredential) {
        configurationCode = 'missing_credential';
        configurationMessage = '渠道未配置上游凭据，请在渠道配置中重新填写。';
        throw new ApiError('service_unavailable');
      }
      const forwarding = await readChannelForForwarding(context.env.DB, channelId);
      if (
        !forwarding ||
        forwarding.status !== 'active' ||
        forwarding.configVersion !== channel.configVersion
      )
        throw new ApiError('conflict');
      const timeoutMs = dependencies.timeoutMs ?? 10_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
        throw new ApiError('service_unavailable');
      const outputLimit = Math.min(
        PROBE_MAX_OUTPUT_TOKENS,
        model.maxOutputTokens,
        mapping.capabilities.maxOutputTokens ?? PROBE_MAX_OUTPUT_TOKENS,
      );
      upstreamKey = forwarding.upstreamKey;
      evidence.phases.push({
        name: 'configuration',
        durationMs: elapsed(phaseStartedAt),
        state: 'completed',
      });
      phase = 'audit_intent';
      phaseStartedAt = now();
      const actorId = context.get('user').id;
      const audit = (action: string) =>
        buildAuditStatement(context.env.DB, {
          actor_id: actorId,
          action,
          target_type: 'channel',
          target_id: channelId,
          operation_id: diagnosticId,
          created_at: now(),
          changes: {
            channel_id: channelId,
            public_model_id: body.publicModelId,
            protocol: body.protocol,
            config_version: channel.configVersion,
            version: mapping.configVersion,
            price_version: model.priceVersion,
            max_output_tokens: outputLimit,
            quantity: 1,
          },
        });
      try {
        await batch(context.env.DB, [
          prepare(
            context.env.DB,
            `SELECT CASE WHEN EXISTS(
        SELECT 1 FROM users u JOIN groups g ON g.id=u.group_id JOIN sessions s ON s.user_id=u.id
        JOIN channels c ON c.id=? JOIN channel_models cm ON cm.channel_id=c.id
        JOIN models m ON m.public_model_id=cm.public_model_id
        WHERE u.id=? AND u.role='admin' AND u.status='active' AND g.status='active'
          AND s.id=? AND s.revoked_at IS NULL AND s.expires_at>?
          AND c.status='active' AND c.config_version=? AND m.status='active' AND m.public_model_id=? AND m.price_version=?
          AND cm.protocol=? AND cm.config_version=? AND cm.upstream_model=?
        ) THEN 1 ELSE json_extract('{}','channel_probe_conflict') END`,
            [
              channelId,
              actorId,
              context.get('session').id,
              now(),
              channel.configVersion,
              body.publicModelId,
              model.priceVersion,
              body.protocol,
              mapping.configVersion,
              mapping.upstreamModel,
            ],
          ),
          audit('channel.test.intent'),
        ]);
      } catch (error) {
        if (error instanceof Error && error.message.includes('channel_probe_conflict'))
          throw new ApiError('conflict');
        throw new ApiError('service_unavailable');
      }
      evidence.phases.push({
        name: 'audit_intent',
        durationMs: elapsed(phaseStartedAt),
        state: 'completed',
      });
      phase = 'dispatch';
      phaseStartedAt = now();
      const result = await runChannelDiagnostic({
        baseUrl: forwarding.baseUrl,
        upstreamKey: forwarding.upstreamKey,
        protocol: body.protocol,
        upstreamModel: mapping.upstreamModel,
        publicModelId: body.publicModelId,
        diagnosticId,
        requestId: context.get('requestId'),
        startedAt,
        timeoutMs,
        maxOutputTokens: outputLimit,
        signal: context.req.raw.signal,
        now,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      });
      evidence = { ...result.evidence, phases: [...evidence.phases, ...result.evidence.phases] };
      const { outcome, upstreamStatus } = result;
      phase = 'audit_result';
      phaseStartedAt = now();
      // Bodies and provider messages never enter management audit records.
      await audit(
        `channel.test.${outcome}${upstreamStatus === null ? '' : `.${upstreamStatus}`}`,
      ).run();
      evidence.phases.push({
        name: 'audit_result',
        durationMs: elapsed(phaseStartedAt),
        state: 'completed',
      });
      evidence.durationMs = elapsed(startedAt);
      return apiSuccess(
        {
          diagnosticId,
          channelId,
          publicModelId: body.publicModelId,
          protocol: body.protocol,
          outcome,
          upstreamStatus,
          channelVersion: channel.configVersion,
          mappingVersion: mapping.configVersion,
          priceVersion: model.priceVersion,
          maxOutputTokens: outputLimit,
          mayIncurUpstreamCost: true,
          userBalanceCharged: false,
          evidence,
        },
        context.get('requestId'),
      );
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'service_unavailable';
      evidence.phases.push({ name: phase, durationMs: elapsed(phaseStartedAt), state: 'failed' });
      evidence.durationMs = elapsed(startedAt);
      const previousFailure = evidence.failure;
      const message =
        phase === 'audit_intent'
          ? code === 'conflict'
            ? '诊断执行前，身份或渠道配置已变化；请求未发起。'
            : '诊断意图审计写入失败；请求未发起。'
          : phase === 'audit_result'
            ? evidence.response !== null
              ? '已收到上游响应，但诊断结果审计写入失败。'
              : '诊断结果审计写入失败；本次执行状态与已有失败详情仍可查看。'
            : code === 'conflict'
              ? '渠道、模型或映射配置已变化；请重新读取配置。'
              : (configurationMessage ?? '渠道配置读取或诊断准备失败。');
      const issues =
        previousFailure === null
          ? []
          : [
              {
                path: `$.failure.${previousFailure.phase}`,
                message: `${previousFailure.code ? `${previousFailure.code}: ` : ''}${previousFailure.message}`,
              },
              ...previousFailure.issues.slice(0, 63),
            ];
      evidence.failure = {
        source: 'cheapai',
        phase: phase === 'audit_intent' || phase === 'audit_result' ? 'audit' : phase,
        code: configurationCode ?? code,
        message,
        issues,
      };
      throw new ChannelDiagnosticApiError(code, {
        diagnosticId,
        evidence: redactDiagnosticEvidence(
          evidence,
          upstreamKey === undefined ? [] : [upstreamKey],
        ),
      });
    }
  });
  return app;
}
