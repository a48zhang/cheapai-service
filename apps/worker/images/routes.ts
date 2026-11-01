import { Hono } from 'hono';
import { imageGenerateInputSchema, imageModelInputSchema } from '@cheapai/contracts/images';
import type { Env } from '../env';
import { ApiError, apiError, apiSuccess, parsePagination } from '../http';
import { requireSession } from '../auth/middleware';
import type { AuthVariables } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { validateCsrfRequest } from '../auth/csrf';
import { readGatewayJson } from '../gateway/read-json';
import { choices, getJob, history, jobView, listModels, recover, saveModel } from './repository';
import { startImage } from './service';

export const IMAGE_API_PATH = '/api/v1/images';
export const IMAGE_ADMIN_PATH = '/api/v1/admin/image-models';
export function createImageRoutes(options: { fetch?: typeof fetch; now?: () => number } = {}) {
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  const now = options.now ?? Date.now;
  app.use('*', requireSession(now));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      if (!c.env.PUBLIC_BASE_URL) throw new ApiError('service_unavailable');
      validateCsrfRequest(c.req.raw, c.env.PUBLIC_BASE_URL);
    }
    await next();
  });
  app.use(IMAGE_ADMIN_PATH, requireAdmin);
  app.use(`${IMAGE_ADMIN_PATH}/*`, requireAdmin);
  app.onError((error, c) => apiError(error, c.get('requestId')));
  app.get(`${IMAGE_API_PATH}/models`, async (c) =>
    apiSuccess(
      { items: await choices(c.env.DB, c.get('user').id), available: Boolean(c.env.IMAGE_ASSETS) },
      c.get('requestId'),
    ),
  );
  app.get(`${IMAGE_API_PATH}/generations`, async (c) =>
    apiSuccess(
      await history(
        c.env.DB,
        c.get('user').id,
        parsePagination(new URL(c.req.url).searchParams).cursor,
        now(),
      ),
      c.get('requestId'),
    ),
  );
  app.post(`${IMAGE_API_PATH}/generations`, async (c) => {
    const parsed = imageGenerateInputSchema.safeParse(await readGatewayJson(c.req.raw));
    if (!parsed.success) throw new ApiError('invalid_request');
    return apiSuccess(
      await startImage(c.env, c.get('user').id, parsed.data, options),
      c.get('requestId'),
    );
  });
  app.get(`${IMAGE_API_PATH}/generations/:id`, async (c) => {
    const row = await getJob(c.env.DB, c.get('user').id, c.req.param('id'));
    if (!row) throw new ApiError('not_found');
    return apiSuccess(jobView(await recover(c.env.DB, row, now())), c.get('requestId'));
  });
  app.get(`${IMAGE_API_PATH}/generations/:id/content`, async (c) => {
    const row = await getJob(c.env.DB, c.get('user').id, c.req.param('id'));
    if (!row || row.status !== 'completed' || !row.asset_key) throw new ApiError('not_found');
    if (!c.env.IMAGE_ASSETS) throw new ApiError('service_unavailable');
    const image = await c.env.IMAGE_ASSETS.get(row.asset_key);
    if (!image) throw new ApiError('not_found');
    const extension =
      row.media_type === 'image/jpeg' ? 'jpg' : row.media_type === 'image/webp' ? 'webp' : 'png';
    return new Response(image.body, {
      headers: {
        'Content-Type': row.media_type ?? 'application/octet-stream',
        'Content-Disposition': `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; filename="image-${row.id}.${extension}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  });
  app.get(IMAGE_ADMIN_PATH, async (c) =>
    apiSuccess(
      { items: await listModels(c.env.DB), storageReady: Boolean(c.env.IMAGE_ASSETS) },
      c.get('requestId'),
    ),
  );
  app.post(IMAGE_ADMIN_PATH, async (c) => {
    const parsed = imageModelInputSchema.safeParse(await readGatewayJson(c.req.raw, 32768));
    if (!parsed.success) throw new ApiError('invalid_request');
    return apiSuccess(
      await saveModel(c.env.DB, c.get('user').id, parsed.data, now()),
      c.get('requestId'),
      201,
    );
  });
  app.patch(`${IMAGE_ADMIN_PATH}/:id`, async (c) => {
    const raw = await readGatewayJson(new Request(c.req.raw, { method: 'POST' }), 32768);
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('version' in raw) ||
      !Number.isSafeInteger(raw.version) ||
      Number(raw.version) < 1
    )
      throw new ApiError('invalid_request');
    const { version, ...input } = raw;
    const parsed = imageModelInputSchema.safeParse(input);
    if (!parsed.success) throw new ApiError('invalid_request');
    return apiSuccess(
      await saveModel(c.env.DB, c.get('user').id, parsed.data, now(), {
        id: c.req.param('id'),
        version: Number(version),
      }),
      c.get('requestId'),
    );
  });
  return app;
}
