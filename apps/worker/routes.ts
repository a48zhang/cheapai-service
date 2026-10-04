import { Hono } from 'hono';
import { createBalanceRoutes, ACCOUNT_BALANCE_PATH } from './billing/balance-routes';
import { createBillingEntryRoutes, BILLING_ENTRIES_PATH, ADMIN_BILLING_ENTRIES_PATH } from './billing/entry-routes';
import { createAdminBalanceRoutes, ADMIN_BALANCE_PATH } from './admin/balance-routes';
import type { Env } from './env';
import { ApiError, apiError, apiSuccess, createRequestId, parsePagination } from './http';
import type { SuccessEnvelope } from './http';
import { createPublicSettingsRoutes } from './auth/public-settings-routes';
import type { PublicSettingsData } from './auth/public-settings-routes';
import { createLoginRoutes, LOGIN_PATH } from './auth/login-routes';
import { createRegisterRoutes, REGISTER_PATH } from './auth/register-routes';
import { createSendCodeRoutes, SEND_VERIFY_CODE_PATH } from './auth/send-code';
import { createSessionRoutes } from './auth/session-routes';
import { normalizeEmail } from './auth/email-proof';
import { resolveEmailSender } from './auth/email-provider';
import type { EmailSenderBinding } from './auth/email-sender';
import { createRegistrationSettingsRoutes, ADMIN_REGISTRATION_SETTINGS_PATH } from './admin/registration-settings-routes';
import { createRegistrationCodeRoutes, REGISTRATION_CODES_PATH, REGISTRATION_CODE_REVOKE_PATH } from './admin/registration-code-routes';
import { createAdminUserRoutes, ADMIN_USERS_PATH } from './admin/user-routes';
import { createKeyRoutes, PLATFORM_KEYS_PATH } from './auth/key-routes';
import { createAdminKeyRoutes, ADMIN_KEY_REVOKE_PATH } from './admin/key-routes';
import { createChannelRoutes, ADMIN_CHANNELS_PATH } from './admin/channel-routes';
import { createGroupRoutes, ADMIN_GROUPS_PATH } from './admin/group-routes';
import { createModelRoutes, ADMIN_MODELS_PATH } from './admin/model-routes';
import { createMappingRoutes, ADMIN_MAPPINGS_PATH, ADMIN_MAPPING_UPDATE_PATH } from './admin/mapping-routes';
import { readChannelKeyring } from './channel-keyring';
import { createRequestQueryRoutes, PERSONAL_REQUESTS_PATH, ADMIN_REQUESTS_PATH } from './gateway/request-query-routes';
import { createSettlementRoutes, RETRY_SETTLEMENT_PATH } from './admin/settlement-routes';
import { createAuditRoutes, ADMIN_AUDIT_PATH } from './admin/audit-routes';
import { createTestChannelRoutes, TEST_CHANNEL_PATH } from './gateway/test-channel-route';
import { createChatRoute, CHAT_COMPLETIONS_PATH } from './gateway/chat-route';
import { createResponsesRoute, RESPONSES_PATH } from './gateway/responses-route';
import { createMessagesRoute, MESSAGES_PATH } from './gateway/messages-route';
import { createModelsRoute, MODELS_PATH } from './gateway/models-route';
import { createChatRoutes as createWebChatRoutes, CHAT_API_PATH } from './chat/routes';
import { reconcileBalances } from './billing/reconciliation';
import { requireSession } from './auth/middleware';
import type { AuthEnv } from './auth/middleware';
import { requireAdmin } from './auth/roles';

export const routes = new Hono<{ Bindings: Env }>();

// Liveness only: this does not claim database, email, or upstream readiness.
routes.get('/healthz', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ status: 'ok' }, 200);
});

function unavailable(): never { throw new ApiError('service_unavailable'); }

/** Configuration is resolved per request, not while the module is imported. */
function trustedOriginFromConfig(env: Env): string {
  if (!env || typeof env.PUBLIC_BASE_URL !== 'string') unavailable();
  let origin: string;
  try {
    const url = new URL(env.PUBLIC_BASE_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) unavailable();
    origin = url.origin;
    if (env.PUBLIC_BASE_URL !== origin && env.PUBLIC_BASE_URL !== `${origin}/`) unavailable();
  } catch { return unavailable(); }
  return origin;
}

function trustedEntryConfiguration(env: Env) {
  if (!env || !['local', 'staging', 'production'].includes(env.ENVIRONMENT)) unavailable();
  return { trustedOrigin: trustedOriginFromConfig(env) };
}

/** Registration-related endpoints require explicit, valid mail readiness.
 * Existing-account login does not consume email configuration or bindings.
 */
function trustedEmailConfiguration(env: Env) {
  const ready = env.EMAIL_VERIFICATION_READY;
  if (ready !== undefined && ready !== true && ready !== false && ready !== 'true' && ready !== 'false') unavailable();
  const emailAvailable = ready === true || ready === 'true';
  let hmacKey: Uint8Array | undefined;
  let emailFrom: string | undefined;
  let email: EmailSenderBinding | undefined;
  if (emailAvailable) {
    email = resolveEmailSender(env);
    if (typeof env.EMAIL_HMAC_KEY !== 'string' || env.EMAIL_HMAC_KEY.length > 684 || typeof env.EMAIL_FROM !== 'string'
      || !email) unavailable();
    try {
      const decoded = atob(env.EMAIL_HMAC_KEY);
      if (decoded.length < 32 || decoded.length > 512 || btoa(decoded) !== env.EMAIL_HMAC_KEY) unavailable();
      hmacKey = Uint8Array.from(decoded, c => c.charCodeAt(0));
      emailFrom = normalizeEmail(env.EMAIL_FROM);
    } catch { return unavailable(); }
  }
  return { emailAvailable, hmacKey, emailFrom, email };
}

// Each factory owns authentication and write protection. Origin resolvers are
// deliberately closures: missing configuration cannot preempt a 401/403, and
// reads do not require PUBLIC_BASE_URL. Only registration diagnostics inspect
// mail readiness; malformed mail configuration is represented as unready.
function userManagement(env: Env) {
  return createAdminUserRoutes({ database: env.DB, now: Date.now, trustedOrigin: () => trustedOriginFromConfig(env) });
}
function codeManagement(env: Env) {
  return createRegistrationCodeRoutes({ database: env.DB, now: Date.now, trustedOrigin: () => trustedOriginFromConfig(env) });
}
function registrationManagement(env: Env) {
  let emailAvailable = false;
  try { emailAvailable = trustedEmailConfiguration(env).emailAvailable; } catch { /* Display unready diagnostics; do not hide the settings UI. */ }
  return createRegistrationSettingsRoutes<Env>({ now: Date.now, emailAvailable, trustedOrigin: () => trustedOriginFromConfig(env) });
}
const personalKeys = createKeyRoutes<Env>({ now: Date.now, trustedOrigin: env => trustedOriginFromConfig(env) });
const adminKeys = createAdminKeyRoutes<Env>({ now: Date.now, trustedOrigin: env => trustedOriginFromConfig(env) });

// Explicit method/path dispatch keeps factory wildcard middleware local and
// leaves unsupported paths as the main app's JSON 404 rather than an auth error.
routes.on(['GET', 'PATCH'], ADMIN_REGISTRATION_SETTINGS_PATH, c => registrationManagement(c.env).fetch(c.req.raw, c.env));
routes.on(['GET', 'POST'], REGISTRATION_CODES_PATH, c => codeManagement(c.env).fetch(c.req.raw, { DB: c.env.DB }));
routes.post(REGISTRATION_CODE_REVOKE_PATH, c => codeManagement(c.env).fetch(c.req.raw, { DB: c.env.DB }));
routes.on(['GET', 'POST'], ADMIN_USERS_PATH, c => userManagement(c.env).fetch(c.req.raw, { DB: c.env.DB }));
routes.patch(`${ADMIN_USERS_PATH}/:id`, c => userManagement(c.env).fetch(c.req.raw, { DB: c.env.DB }));
routes.get(`${ADMIN_USERS_PATH}/:id`, c => userManagement(c.env).fetch(c.req.raw, { DB: c.env.DB }));
routes.on(['GET', 'POST'], PLATFORM_KEYS_PATH, c => personalKeys.fetch(c.req.raw, c.env));
routes.get('/api/v1/account/key-groups', c => personalKeys.fetch(c.req.raw, c.env));
routes.on(['GET', 'PATCH'], `${PLATFORM_KEYS_PATH}/:id`, c => personalKeys.fetch(c.req.raw, c.env));
routes.post(`${PLATFORM_KEYS_PATH}/:id/revoke`, c => personalKeys.fetch(c.req.raw, c.env));
routes.post(ADMIN_KEY_REVOKE_PATH, c => adminKeys.fetch(c.req.raw, c.env));

// Configuration CRUD shares the factories' authorization and lazy write-only
// origin/key resolution. GET and anonymous requests never read encryption keys.
const channels = createChannelRoutes<Env>({ now: Date.now, trustedOrigin: env => trustedOriginFromConfig(env),
  encryptionKey: env => readChannelKeyring(env).active });
const models = createModelRoutes<Env>({ now: Date.now, trustedOrigin: env => trustedOriginFromConfig(env) });
const mappings = createMappingRoutes<Env>({ now: Date.now, trustedOrigin: env => trustedOriginFromConfig(env) });
function groupManagement(env: Env) {
  return createGroupRoutes({ database: env.DB, now: Date.now, trustedOrigin: () => trustedOriginFromConfig(env) });
}
routes.on(['GET', 'POST'], ADMIN_CHANNELS_PATH, c => channels.fetch(c.req.raw, c.env));
routes.patch(`${ADMIN_CHANNELS_PATH}/:id`, c => channels.fetch(c.req.raw, c.env));
routes.get(`${ADMIN_CHANNELS_PATH}/:id`, c => channels.fetch(c.req.raw, c.env));
// These narrow-binding factories clone their local env; pass only DB so a clone
// cannot accidentally read Secret properties. Origin closures retain trusted env.
routes.on(['GET', 'POST'], ADMIN_GROUPS_PATH, c => groupManagement(c.env).fetch(c.req.raw, { DB: c.env.DB }));
routes.patch(`${ADMIN_GROUPS_PATH}/:id`, c => groupManagement(c.env).fetch(c.req.raw, { DB: c.env.DB }));
routes.get(`${ADMIN_GROUPS_PATH}/:id`, c => groupManagement(c.env).fetch(c.req.raw, { DB: c.env.DB }));
routes.on(['GET', 'POST'], ADMIN_MODELS_PATH, c => models.fetch(c.req.raw, c.env));
routes.patch(`${ADMIN_MODELS_PATH}/:id`, c => models.fetch(c.req.raw, c.env));
routes.get(`${ADMIN_MODELS_PATH}/:id`, c => models.fetch(c.req.raw, c.env));
routes.on(['GET', 'POST'], ADMIN_MAPPINGS_PATH, c => mappings.fetch(c.req.raw, c.env));
routes.patch(ADMIN_MAPPING_UPDATE_PATH, c => mappings.fetch(c.req.raw, c.env));

// Read/adjustment billing endpoints do not depend on gateway or Cron readiness.
// Request history, known-evidence recovery, reconciliation and audit are kept
// on their own narrow factories so each route retains its scope and error wire.
const accountBalances = createBalanceRoutes();
const billingEntries = createBillingEntryRoutes();
const requestQueries = createRequestQueryRoutes();
const auditQueries = createAuditRoutes();
export const ADMIN_RECONCILIATION_PATH = '/api/v1/admin/billing/reconciliation';
const reconciliationQueries = new Hono<AuthEnv>();
reconciliationQueries.onError((error, context) => {
  const response = apiError(error instanceof ApiError ? error : new ApiError('service_unavailable'), context.get('requestId') ?? createRequestId());
  response.headers.set('Cache-Control', 'no-store'); return response;
});
reconciliationQueries.get(ADMIN_RECONCILIATION_PATH, requireSession(), requireAdmin, async context => {
  const query = new URL(context.req.url).searchParams;
  for (const key of query.keys()) if (!['limit', 'cursor'].includes(key) || query.getAll(key).length !== 1) throw new ApiError('invalid_request');
  const page = parsePagination(query);
  const result = await reconcileBalances(context.env.DB, context.get('user').id, {
    limit: page.limit, ...(page.cursor === null ? {} : { cursor: page.cursor }),
  });
  const response = apiSuccess(result, context.get('requestId'));
  response.headers.set('Cache-Control', 'no-store'); return response;
});
reconciliationQueries.notFound(context => {
  const response = apiError(new ApiError('not_found'), context.get('requestId') ?? createRequestId());
  response.headers.set('Cache-Control', 'no-store'); return response;
});
function settlementManagement(env: Env) {
  return createSettlementRoutes({ now: Date.now, trustedOrigin: () => trustedOriginFromConfig(env) });
}
function channelDiagnostics(env: Env) {
  return createTestChannelRoutes<Env>({ now: Date.now, trustedOrigin: () => trustedOriginFromConfig(env),
    keyring: () => readChannelKeyring(env).keyring });
}
const chatGateway = createChatRoute();
const responsesGateway = createResponsesRoute();
const messagesGateway = createMessagesRoute();
const modelsGateway = createModelsRoute();
type MountedRoute = { fetch(request: Request, env?: unknown, executionCtx?: ExecutionContext): Response | Promise<Response> };
const detachedExecutionContext = { waitUntil(work: Promise<unknown>) { void work; }, passThroughOnException() { /* Hono test calls have no event. */ }, props: {} } as unknown as ExecutionContext;
function mountedExecutionContext(context: { executionCtx: unknown }): ExecutionContext | undefined {
  try { return context.executionCtx as ExecutionContext; } catch { return undefined; }
}
function forwardMounted(route: MountedRoute, context: { req: { raw: Request }; env: unknown; executionCtx: unknown }): Promise<Response> {
  const executionCtx = mountedExecutionContext(context) ?? detachedExecutionContext;
  return Promise.resolve(route.fetch(context.req.raw, context.env, executionCtx));
}
routes.get(ACCOUNT_BALANCE_PATH, c => accountBalances.fetch(c.req.raw, { DB: c.env.DB }));
routes.get(BILLING_ENTRIES_PATH, c => billingEntries.fetch(c.req.raw, { DB: c.env.DB }));
routes.get(ADMIN_BILLING_ENTRIES_PATH, c => billingEntries.fetch(c.req.raw, { DB: c.env.DB }));
routes.post(ADMIN_BALANCE_PATH, c => createAdminBalanceRoutes({ database: c.env.DB, now: Date.now,
  trustedOrigin: () => trustedOriginFromConfig(c.env) }).fetch(c.req.raw, { DB: c.env.DB }));
routes.get(PERSONAL_REQUESTS_PATH, c => requestQueries.fetch(c.req.raw, { DB: c.env.DB }));
routes.get(`${PERSONAL_REQUESTS_PATH}/:id`, c => requestQueries.fetch(c.req.raw, { DB: c.env.DB }));
routes.get(ADMIN_REQUESTS_PATH, c => requestQueries.fetch(c.req.raw, { DB: c.env.DB }));
routes.get(`${ADMIN_REQUESTS_PATH}/:id`, c => requestQueries.fetch(c.req.raw, { DB: c.env.DB }));
routes.post(RETRY_SETTLEMENT_PATH, c => settlementManagement(c.env).fetch(c.req.raw, { DB: c.env.DB }));
routes.get(ADMIN_RECONCILIATION_PATH, c => reconciliationQueries.fetch(c.req.raw, { DB: c.env.DB }));
routes.get(ADMIN_AUDIT_PATH, c => auditQueries.fetch(c.req.raw, { DB: c.env.DB }));
routes.post(TEST_CHANNEL_PATH, c => channelDiagnostics(c.env).fetch(c.req.raw, { DB: c.env.DB }));
// Gateway factories own native authentication/errors. Delegate the entire
// fixed path so method mismatches also stay in the native protocol envelope.
routes.all(CHAT_COMPLETIONS_PATH, c => forwardMounted(chatGateway, c));
routes.all(RESPONSES_PATH, c => forwardMounted(responsesGateway, c));
routes.all(MESSAGES_PATH, c => forwardMounted(messagesGateway, c));
routes.get(MODELS_PATH, c => modelsGateway.fetch(c.req.raw, { DB: c.env.DB }));
// Web chat authenticates its cookie session, then enters the shared gateway
// with a server-owned virtual identity. Credentials are resolved only on send.
for (const path of [CHAT_API_PATH, `${CHAT_API_PATH}/*`]) {
  routes.all(path, c => forwardMounted(createWebChatRoutes({
    trustedOrigin: () => trustedOriginFromConfig(c.env),
    keyring: () => readChannelKeyring(c.env).keyring,
  }), c));
}

// GET identity restoration requires only its authoritative DB/session state.
// Logout resolves origin lazily, without coupling logout to email readiness.
routes.get('/api/v1/auth/me', context => createSessionRoutes().fetch(context.req.raw, context.env));
routes.post('/api/v1/auth/logout', context => createSessionRoutes({
  trustedOrigin: () => trustedOriginFromConfig(context.env),
}).fetch(context.req.raw, context.env));

/** Only native edge metadata establishes that the connecting-IP header was
 * supplied by Cloudflare. User JSON, Host, Origin, XFF and synthetic CF headers
 * are never provenance. Worker-to-Worker callers must use a separate trust path.
 */
function trustedClientIp(env: Env, request: Request): string {
  if (env.ENVIRONMENT === 'local') return '127.0.0.1';
  const cf = request.cf;
  if (!cf || typeof cf.colo !== 'string' || !/^[A-Z]{3}$/.test(cf.colo)
    || typeof cf.httpProtocol !== 'string' || cf.httpProtocol.length === 0) unavailable();
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip === null || ip.length > 45 || !/^[0-9a-fA-F:.]+$/.test(ip)) unavailable();
  return ip; // A10 applies canonical IPv4/IPv6 validation before using the key.
}

const paths = ['/api/v1/settings/public', LOGIN_PATH, REGISTER_PATH, SEND_VERIFY_CODE_PATH] as const;
for (const path of paths) {
  routes.on(path === '/api/v1/settings/public' ? 'GET' : 'POST', path, async context => {
    try {
      const env = context.env;
      const { trustedOrigin } = trustedEntryConfiguration(env);
      const request = context.req.raw;
      const common = { database: env.DB, gates: env.GATE, now: () => Date.now() };
      if (path === LOGIN_PATH) {
        return await createLoginRoutes<Env>({ ...common, trustedOrigin,
          trustedIp: req => trustedClientIp(env, req) }).fetch(request, env);
      }
      if (path === '/api/v1/settings/public') {
        let emailAvailable = false;
        let invalidMailConfiguration = false;
        try { emailAvailable = trustedEmailConfiguration(env).emailAvailable; }
        catch { invalidMailConfiguration = true; }
        // Anonymous login bootstrap must survive mail configuration failures.
        // Reuse A30's nonce/cookie validation and A09's authoritative D1 read;
        // never turn a storage/CSRF failure into a successful settings response.
        const response = await createPublicSettingsRoutes({ database: env.DB, emailAvailable }).fetch(request, env);
        if (!invalidMailConfiguration || response.status !== 200) return response;
        const body = await response.json<SuccessEnvelope<PublicSettingsData>>();
        // A09 permits open/unverified registration when emailAvailable=false.
        // But malformed mail configuration still blocks the register endpoint,
        // so project it as closed without changing the stored policy or nonce.
        return Response.json({ ...body, data: { ...body.data, registrationMode: 'closed', emailVerificationEnabled: true } }, {
          status: response.status, headers: response.headers,
        });
      }
      const config = trustedEmailConfiguration(env);
      if (path === REGISTER_PATH) {
        return await createRegisterRoutes<Env>({ trustedOrigin,
          resolve: (_bindings, req) => ({ ...common, trustedIp: trustedClientIp(env, req), emailAvailable: config.emailAvailable,
            ...(config.hmacKey === undefined ? {} : { hmacKey: config.hmacKey }) }),
        }).fetch(request, env);
      }
      if (!config.emailAvailable || config.hmacKey === undefined || config.emailFrom === undefined || !config.email) unavailable();
      return await createSendCodeRoutes({ ...common, trustedOrigin,
        trustedIp: req => trustedClientIp(env, req), email: config.email, emailFrom: config.emailFrom, hmacKey: config.hmacKey,
      }).fetch(request, env);
    } catch (error) {
      console.error('Auth route failed', { path }, error);
      const response = apiError(new ApiError('service_unavailable'), createRequestId());
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
  });
}
