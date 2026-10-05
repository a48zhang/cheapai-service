import { logError } from '../logging';
import { Hono } from 'hono';
import { authenticatePlatformKey, PlatformKeyAuthError } from '../auth/api-key-auth';
import { prepare } from '../db';

export const MODELS_PATH = '/v1/models';
export interface PublicModelEntry { id: string; object: 'model'; created: number; owned_by: 'sub2api' }
class InvalidModelListRequest extends Error {}

/** Native OpenAI-compatible catalog. A valid Key with no visible models gets an
 * empty list; no group/owner/limit can be supplied by query or body parameters.
 * No hidden LIMIT: a DB/runtime size failure is an error, never a partial "all".
 */
export function createModelsRoute(dependencies: { now?: () => number } = {}): Hono<{ Bindings: { DB: D1Database } }> {
  const app = new Hono<{ Bindings: { DB: D1Database } }>();
  app.get(MODELS_PATH, async (context) => {
    let response: Response;
    try {
      const now = (dependencies.now ?? Date.now)();
      const auth = await authenticatePlatformKey(context.env.DB, context.req.raw, now);
      if (new URL(context.req.url).search !== '') throw new InvalidModelListRequest();
      const result = await prepare<{ public_model_id: string; created_at: number }>(context.env.DB, `
        SELECT m.public_model_id,m.created_at FROM models m
        WHERE m.status='active' AND m.created_at<=? AND EXISTS (
          SELECT 1 FROM api_keys k JOIN users u ON u.id=k.user_id JOIN groups g ON g.id=k.group_id
          JOIN user_group_access access ON access.user_id=u.id AND access.group_id=g.id
          WHERE k.id=? AND u.id=? AND g.id=?
            AND k.status='active' AND u.status='active' AND g.status='active'
            AND k.created_at<=? AND (k.expires_at IS NULL OR k.expires_at>?)
            AND (k.allowed_models_json IS NULL OR EXISTS (
              SELECT 1 FROM json_each(k.allowed_models_json) selection WHERE selection.type='text' AND selection.value=m.public_model_id))
            AND NOT EXISTS (SELECT 1 FROM json_each(k.allowed_models_json) selection WHERE selection.type<>'text')
            AND EXISTS (SELECT 1 FROM channel_models cm JOIN channels c ON c.id=cm.channel_id
              JOIN channel_groups cg ON cg.channel_id=c.id
              WHERE cm.public_model_id=m.public_model_id AND c.status='active' AND c.created_at<=? AND cg.group_id=g.id)
        ) ORDER BY m.public_model_id`, [now, auth.key.id, auth.user.id, auth.group.id, now, now, now]).all();
      const data: PublicModelEntry[] = result.rows.map((row) => {
        if (typeof row.public_model_id !== 'string' || row.public_model_id.length < 1 || row.public_model_id.length > 128
            || row.public_model_id.trim() !== row.public_model_id || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(row.public_model_id)
            || !Number.isSafeInteger(row.created_at) || row.created_at < 0) throw new Error();
        return { id: row.public_model_id, object: 'model', created: Math.floor(row.created_at / 1000), owned_by: 'sub2api' };
      });
      response = Response.json({ object: 'list', data });
    } catch (error) {
      const invalidKey = error instanceof PlatformKeyAuthError && error.reason === 'invalid_api_key';
      const conflict = error instanceof PlatformKeyAuthError && error.reason === 'conflicting_api_key_headers';
      const invalidRequest = error instanceof InvalidModelListRequest;
      const status = invalidKey ? 401 : conflict || invalidRequest ? 400 : 503;
      if (status >= 500) logError('Gateway model list failed', error, { path: MODELS_PATH });
      else console.warn('Gateway model list rejected', { status }, error);
      response = Response.json({ error: {
        message: invalidKey ? 'Invalid API key.' : conflict ? 'Conflicting API key headers.' : invalidRequest ? 'Invalid model list request.' : 'Service temporarily unavailable.',
        type: invalidKey ? 'authentication_error' : conflict || invalidRequest ? 'invalid_request_error' : 'server_error',
        code: invalidKey ? 'invalid_api_key' : conflict ? 'conflicting_api_key_headers' : invalidRequest ? 'invalid_request' : 'service_unavailable', param: null,
      } }, { status });
    }
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });
  return app;
}
