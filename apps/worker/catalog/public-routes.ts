import { Hono } from 'hono';
import { decodeCatalog } from '@cheapai/contracts/catalog';
import { formatUnitsToUsd } from '../billing/money';
import { prepare } from '../db';
import type { Env } from '../env';
import { ApiError, apiError, apiSuccess, createRequestId } from '../http';
import { validateModelPrices } from './models';

export const PUBLIC_CATALOG_PATH = '/api/v1/catalog/models';

/** Only publish sell prices and public names from configured, active routes.
 * Account/Key permissions and group multipliers still apply when making calls.
 */
export function createPublicCatalogRoutes() {
  const routes = new Hono<{ Bindings: Pick<Env, 'DB' | 'IMAGE_ASSETS'> }>();
  routes.get(PUBLIC_CATALOG_PATH, async (context) => {
    const requestId = createRequestId();
    let response: Response;
    try {
      const text = await prepare<{ public_model_id: string; sell_prices_json: string }>(
        context.env.DB,
        `SELECT m.public_model_id,m.sell_prices_json FROM models m
         WHERE m.status='active' AND EXISTS (
           SELECT 1 FROM channel_models cm
           JOIN channels c ON c.id=cm.channel_id AND c.status='active' AND c.deleted_at IS NULL
           JOIN channel_groups cg ON cg.channel_id=c.id
           JOIN groups g ON g.id=cg.group_id AND g.status='active'
           WHERE cm.public_model_id=m.public_model_id AND cm.protocol IN ('chat','responses','messages')
         ) ORDER BY m.public_model_id`,
      ).all();
      const images = context.env.IMAGE_ASSETS
        ? (await prepare<{ id: string; name: string; price_units: number }>(
            context.env.DB,
            `SELECT m.id,m.name,m.price_units FROM image_models m
             JOIN channels c ON c.id=m.channel_id AND c.status='active' AND c.deleted_at IS NULL
             WHERE m.status='active' AND EXISTS (
               SELECT 1 FROM channel_groups cg JOIN groups g ON g.id=cg.group_id AND g.status='active'
               WHERE cg.channel_id=c.id
             ) ORDER BY m.name,m.id`,
          ).all()).rows
        : [];
      const catalog = decodeCatalog({ items: [
        ...text.rows.map(row => ({
          kind: 'text', id: row.public_model_id,
          prices: validateModelPrices(JSON.parse(row.sell_prices_json)),
        })),
        ...images.map(row => {
          if (!Number.isSafeInteger(row.price_units) || row.price_units < 0) throw new Error('Invalid image price.');
          return { kind: 'image', id: row.id, name: row.name, price: formatUnitsToUsd(BigInt(row.price_units)) };
        }),
      ] });
      response = apiSuccess(catalog, requestId);
    } catch (error) {
      response = apiError(new ApiError('service_unavailable', { cause: error }), requestId);
    }
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });
  return routes;
}
