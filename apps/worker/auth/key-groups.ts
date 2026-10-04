import { prepare } from '../db';
import { ApiError } from '../http';
import { parseBillingMultiplier, PricingError, type PriceTable } from '../billing/pricing';
import { validateModelPrices } from '../catalog/models';

export interface AvailableKeyGroup {
  id: string;
  name: string;
  models: string[];
  billingMultiplier: string;
  modelPrices: Record<string, PriceTable>;
}

interface KeyGroupRow {
  id: string;
  name: string;
  billing_multiplier: string;
  public_model_id: string | null;
  sell_prices_json: string | null;
}

function billingMultiplier(value: string): string {
  try {
    return parseBillingMultiplier(value).text;
  } catch (error) {
    if (error instanceof PricingError) throw new ApiError('service_unavailable');
    throw error;
  }
}

function modelPrices(value: string): PriceTable {
  try {
    return validateModelPrices(JSON.parse(value));
  } catch {
    throw new ApiError('service_unavailable');
  }
}

export async function listAvailableKeyGroups(
  database: D1Database,
  userId: string,
): Promise<AvailableKeyGroup[]> {
  const result = await prepare<KeyGroupRow>(
    database,
    `
    SELECT g.id,g.name,g.billing_multiplier,available.public_model_id,available.sell_prices_json
    FROM user_group_access a JOIN groups g ON g.id=a.group_id JOIN users u ON u.id=a.user_id
    LEFT JOIN (
      SELECT DISTINCT cg.group_id,m.public_model_id,m.sell_prices_json
      FROM channel_groups cg
      JOIN channels c ON c.id=cg.channel_id AND c.status='active'
      JOIN channel_models cm ON cm.channel_id=c.id
      JOIN models m ON m.public_model_id=cm.public_model_id AND m.status='active'
    ) available ON available.group_id=g.id
    WHERE a.user_id=? AND u.status='active' AND g.status='active'
    ORDER BY CASE WHEN g.id=u.group_id THEN 0 ELSE 1 END,g.name,g.id,available.public_model_id`,
    [userId],
  ).all();
  const groups = new Map<string, AvailableKeyGroup>();
  for (const row of result.rows) {
    let group = groups.get(row.id);
    if (group === undefined) {
      group = {
        id: row.id,
        name: row.name,
        models: [],
        billingMultiplier: billingMultiplier(row.billing_multiplier),
        modelPrices: Object.create(null) as Record<string, PriceTable>,
      };
      groups.set(row.id, group);
    }
    if (row.public_model_id !== null && row.sell_prices_json !== null) {
      group.models.push(row.public_model_id);
      group.modelPrices[row.public_model_id] = modelPrices(row.sell_prices_json);
    } else if (row.public_model_id !== null || row.sell_prices_json !== null) {
      throw new ApiError('service_unavailable');
    }
  }
  return [...groups.values()];
}

export function validateGroupSelection(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 100 ||
    !value.every(
      (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(id),
    ) ||
    new Set(value).size !== value.length
  )
    throw new ApiError('invalid_request');
  return [...value] as string[];
}
