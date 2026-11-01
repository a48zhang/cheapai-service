import { Hono } from 'hono';
import { catalogGroupsSchema, decodeCatalog } from '@cheapai/contracts/catalog';
import { multiplyPriceDecimal } from '@cheapai/contracts/price-decimal';
import { formatUnitsToUsd } from '../billing/money';
import { parseBillingMultiplier } from '../billing/pricing';
import { quotedUnits } from '../images/repository';
import { prepare } from '../db';
import type { Env } from '../env';
import { ApiError, apiError, apiSuccess, createRequestId } from '../http';
import { validateModelPrices } from './models';

export const PUBLIC_CATALOG_PATH = '/api/v1/catalog/models';
export const PUBLIC_CATALOG_GROUPS_PATH = '/api/v1/catalog/groups';

/** Publishing is independent of account access. Only explicitly public, active groups are listed. */
export function createPublicCatalogRoutes() {
  const routes = new Hono<{ Bindings: Pick<Env, 'DB' | 'IMAGE_ASSETS'> }>();
  routes.use('*', async (context, next) => {
    await next();
    context.res.headers.set('Cache-Control', 'no-store');
  });
  routes.onError((error) =>
    apiError(
      error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }),
      createRequestId(),
    ),
  );
  routes.get(PUBLIC_CATALOG_GROUPS_PATH, async (context) => {
    const groups = await prepare<{ id: string; name: string }>(
      context.env.DB,
      "SELECT id,name FROM groups WHERE status='active' AND is_public=1 ORDER BY name,id",
    ).all();
    return apiSuccess(catalogGroupsSchema.parse({ items: groups.rows }), createRequestId());
  });
  routes.get(PUBLIC_CATALOG_PATH, async (context) => {
    const query = new URL(context.req.url).searchParams;
    const groupId = query.get('groupId');
    if (
      query.getAll('groupId').length > 1 ||
      (groupId !== null && !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(groupId))
    )
      throw new ApiError('invalid_request');
    const group = await prepare<{ id: string; billing_multiplier: string }>(
      context.env.DB,
      "SELECT id,billing_multiplier FROM groups WHERE status='active' AND is_public=1 AND (? IS NULL OR id=?) ORDER BY name,id LIMIT 1",
      [groupId, groupId],
    ).first();
    if (!group) {
      if (groupId !== null) throw new ApiError('not_found');
      return apiSuccess({ items: [] }, createRequestId());
    }
    try {
      parseBillingMultiplier(group.billing_multiplier);
      const text = await prepare<{ public_model_id: string; sell_prices_json: string }>(
        context.env.DB,
        `SELECT m.public_model_id,m.sell_prices_json FROM models m
       WHERE m.status='active' AND EXISTS (
         SELECT 1 FROM channel_models cm
         JOIN channels c ON c.id=cm.channel_id AND c.status='active' AND c.deleted_at IS NULL
         JOIN channel_groups cg ON cg.channel_id=c.id
         WHERE cg.group_id=? AND cm.public_model_id=m.public_model_id AND cm.protocol IN ('chat','responses','messages')
       ) ORDER BY m.public_model_id`,
        [group.id],
      ).all();
      const images = context.env.IMAGE_ASSETS
        ? (
            await prepare<{ id: string; name: string; price_units: number }>(
              context.env.DB,
              `SELECT m.id,m.name,m.price_units FROM image_models m
           JOIN channels c ON c.id=m.channel_id AND c.status='active' AND c.deleted_at IS NULL
           WHERE m.status='active' AND EXISTS (
             SELECT 1 FROM channel_groups cg WHERE cg.channel_id=c.id AND cg.group_id=?
           ) ORDER BY m.name,m.id`,
              [group.id],
            ).all()
          ).rows
        : [];
      const catalog = decodeCatalog({
        items: [
          ...text.rows.map((row) => {
            const prices = validateModelPrices(JSON.parse(row.sell_prices_json));
            return {
              kind: 'text',
              id: row.public_model_id,
              prices: {
                input: multiplyPriceDecimal(prices.input, group.billing_multiplier),
                output: multiplyPriceDecimal(prices.output, group.billing_multiplier),
                ...(prices.cacheRead === undefined
                  ? {}
                  : {
                      cacheRead: multiplyPriceDecimal(prices.cacheRead, group.billing_multiplier),
                    }),
              },
            };
          }),
          ...images.map((row) => {
            if (!Number.isSafeInteger(row.price_units) || row.price_units < 0)
              throw new Error('Invalid image price.');
            return {
              kind: 'image',
              id: row.id,
              name: row.name,
              price: formatUnitsToUsd(
                BigInt(quotedUnits({ ...row, billing_multiplier: group.billing_multiplier })),
              ),
            };
          }),
        ],
      });
      return apiSuccess(catalog, createRequestId());
    } catch (cause) {
      throw new ApiError('service_unavailable', { cause });
    }
  });
  return routes;
}
