import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { parseRuntimeConfig } from '../config';
import type { RegistrationMode } from '../config';
import { prepare } from '../db';
import { ApiError, apiError, apiSuccess, createRequestId } from '../http';
import { validateCsrfRequest } from '../auth/csrf';
import { requireSession } from '../auth/middleware';
import type { AuthVariables } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { updateRegistrationSettings } from '../auth/registration-settings';
import type { RegistrationSettings } from '../auth/registration-settings';

export const ADMIN_REGISTRATION_SETTINGS_PATH = '/api/v1/admin/registration/settings';
export const REGISTRATION_SETTINGS_BODY_MAX_BYTES = 2048;
export interface RegistrationSettingsRouteDependencies {
  /** Read only by PATCH after session/admin guards. Capture trusted env in a resolver. */
  trustedOrigin?: string | (() => string | Promise<string>);
  emailAvailable: boolean;
  now(): number;
}
export interface AdminRegistrationSettings {
  registrationMode: RegistrationMode | null;
  emailVerificationEnabled: boolean | null;
  version: number | null;
  updatedAt: number | null;
  /** Valid stored settings, independent of transient deployment readiness. */
  valid: boolean;
  ready: boolean;
  emailAvailable: boolean;
  issues: ('missing_settings' | 'invalid_settings' | 'email_unavailable')[];
}
type Bindings = { DB: D1Database };
type RouteEnv<B extends Bindings> = {
  Bindings: B;
  Variables: AuthVariables & { registrationSettingsDependencies: RegistrationSettingsRouteDependencies };
};
export type RegistrationSettingsDependencySource<B extends Bindings> = RegistrationSettingsRouteDependencies
  | ((env: B, request: Request) => RegistrationSettingsRouteDependencies | Promise<RegistrationSettingsRouteDependencies>);

/** Admin diagnostics expose reviewed actual fields, not arbitrary raw JSON.
 * Public settings use A09's separate fail-closed projection.
 */
export async function readAdminRegistrationSettings(database: D1Database, emailAvailable: boolean): Promise<AdminRegistrationSettings> {
  const row = await prepare<{ value_json: string; version: number; updated_at: number }>(database,
    'SELECT value_json,version,updated_at FROM settings WHERE key=?', ['registration']).first();
  const result: AdminRegistrationSettings = {
    registrationMode: null, emailVerificationEnabled: null, version: null, updatedAt: null,
    valid: false, ready: false, emailAvailable, issues: [],
  };
  if (!row) { result.issues.push('missing_settings'); return result; }
  result.version = Number.isSafeInteger(row.version) && row.version >= 1 ? row.version : null;
  result.updatedAt = Number.isSafeInteger(row.updated_at) && row.updated_at >= 0 ? row.updated_at : null;
  try {
    if (typeof row.value_json !== 'string' || row.value_json.length > 2048) throw new Error();
    const value: unknown = JSON.parse(row.value_json);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const stored = value as Record<string, unknown>;
    if (stored.registrationMode === 'closed' || stored.registrationMode === 'open' || stored.registrationMode === 'invite') result.registrationMode = stored.registrationMode;
    if (typeof stored.emailVerificationEnabled === 'boolean') result.emailVerificationEnabled = stored.emailVerificationEnabled;
    if (Object.keys(stored).length !== 2 || result.registrationMode === null || result.emailVerificationEnabled === null
        || result.version === null || result.updatedAt === null) throw new Error();
    parseRuntimeConfig(stored, { emailAvailable: true });
    result.valid = true;
  } catch { result.issues.push('invalid_settings'); return result; }
  if (result.registrationMode !== 'closed' && result.emailVerificationEnabled && !emailAvailable) {
    result.issues.push('email_unavailable');
  } else result.ready = true;
  return result;
}

async function readPatch(request: Request): Promise<{ version: number; patch: Partial<RegistrationSettings> }> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !request.body) throw new ApiError('invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let value: unknown;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > REGISTRATION_SETTINGS_BODY_MAX_BYTES - size) {
        void reader.cancel().catch(() => undefined);
        throw new ApiError('payload_too_large');
      }
      chunks.push(next.value); size += next.value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('invalid_request');
  } finally { reader.releaseLock(); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid_request');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['version', 'registrationMode', 'emailVerificationEnabled'].includes(key))
      || typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1
      || (!Object.hasOwn(body, 'registrationMode') && !Object.hasOwn(body, 'emailVerificationEnabled'))) throw new ApiError('invalid_request');
  const { version, ...patch } = body;
  return { version, patch: patch as Partial<RegistrationSettings> }; // A09 validates both policy fields.
}

/** Lazy trusted configuration; authentication reads the request's env.DB.
 * The factory does not mount itself in the main app or initialize bindings.
 */
export function createRegistrationSettingsRoutes<B extends Bindings = Bindings>(
  source: RegistrationSettingsDependencySource<B>,
): Hono<RouteEnv<B>> {
  const app = new Hono<RouteEnv<B>>();
  app.onError((error, context) => {
    const response = apiError(error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }), context.get('requestId') ?? createRequestId());
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });
  app.use(ADMIN_REGISTRATION_SETTINGS_PATH, async (context, next) => {
    const existing = context.get('requestId');
    context.set('requestId', typeof existing === 'string' ? existing : createRequestId());
    try {
      const dependencies = typeof source === 'function' ? await source(context.env, context.req.raw) : source;
      if (!dependencies || typeof dependencies.now !== 'function' || typeof dependencies.emailAvailable !== 'boolean') throw new ApiError('service_unavailable');
      context.set('registrationSettingsDependencies', dependencies);
      await next();
    } catch (error) {
      context.res = apiError(error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }), context.get('requestId'));
    }
    context.res.headers.set('Cache-Control', 'no-store');
  });
  app.use(ADMIN_REGISTRATION_SETTINGS_PATH, (context, next) => {
    // This route's bindings/variables extend exactly the DB/AuthVariables used
    // by A04; Hono Context's setters otherwise make the generic type invariant.
    const authenticate: MiddlewareHandler = requireSession(context.get('registrationSettingsDependencies').now);
    return authenticate(context, next);
  });
  app.use(ADMIN_REGISTRATION_SETTINGS_PATH, requireAdmin);
  app.get(ADMIN_REGISTRATION_SETTINGS_PATH, async (context) => apiSuccess(
    await readAdminRegistrationSettings(context.env.DB, context.get('registrationSettingsDependencies').emailAvailable), context.get('requestId'),
  ));
  app.patch(ADMIN_REGISTRATION_SETTINGS_PATH, async (context) => {
    const dependencies = context.get('registrationSettingsDependencies');
    const configured = dependencies.trustedOrigin;
    const origin = typeof configured === 'function' ? await configured() : configured;
    if (typeof origin !== 'string') throw new ApiError('service_unavailable');
    validateCsrfRequest(context.req.raw, origin);
    const body = await readPatch(context.req.raw);
    const saved = await updateRegistrationSettings(context.env.DB, {
      expectedVersion: body.version, patch: body.patch, actorId: context.get('user').id,
      operationId: crypto.randomUUID(), now: dependencies.now(),
    }, { emailAvailable: dependencies.emailAvailable });
    return apiSuccess({ ...saved, ready: true, emailAvailable: dependencies.emailAvailable, issues: [] }, context.get('requestId'));
  });
  return app;
}
