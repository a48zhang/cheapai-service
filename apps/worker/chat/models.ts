import { prepare } from '../db';
import { ApiError } from '../http';
import { parseBillingMultiplier, PricingError } from '../billing/pricing';
import { validateModelPrices } from '../catalog/models';
import type { PriceTable } from '../billing/pricing';

/** The catalogue exposed to the browser.  This is deliberately a projection
 * of the current group access graph; it never contains channel credentials or
 * an API key identity. */
export interface ChatModel {
  readonly publicModelId: string;
  readonly sellPrices: PriceTable;
}

export interface ChatGroup {
  readonly id: string;
  readonly name: string;
  readonly billingMultiplier: string;
  readonly models: readonly ChatModel[];
}

export interface AuthorizedChatSelection {
  readonly group: { readonly id: string; readonly name: string; readonly version: number; readonly billingMultiplier: string };
  readonly model: { readonly publicModelId: string };
}

interface AuthorizedCatalogRow {
  group_id: string;
  group_name: string;
  group_version: number;
  billing_multiplier: string;
  public_model_id: string;
}

interface CatalogRow extends AuthorizedCatalogRow {
  sell_prices_json: string;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u;

function invalid(): never { throw new ApiError('invalid_request'); }

function id(value: unknown): string {
  if (typeof value !== 'string' || !identifier.test(value)) invalid();
  return value;
}

function safeInteger(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new ApiError('service_unavailable');
  }
  return value;
}

function sellPrices(value: string): PriceTable {
  try { return validateModelPrices(JSON.parse(value)); }
  catch (error) { throw new ApiError('service_unavailable', { cause: error }); }
}

/** Multiplier validation is shared with billing. Missing or malformed values
 * are unavailable; the chat catalogue never turns a broken price into free. */
export function normalizeBillingMultiplier(value: unknown): string {
  try { return parseBillingMultiplier(value).text; }
  catch (error) { if (error instanceof PricingError) throw new ApiError('service_unavailable', { cause: error }); throw error; }
}

function rowToSelection(row: AuthorizedCatalogRow): AuthorizedChatSelection {
  return Object.freeze({
    group: Object.freeze({ id: id(row.group_id), name: row.group_name, version: safeInteger(row.group_version), billingMultiplier: normalizeBillingMultiplier(row.billing_multiplier) }),
    model: Object.freeze({ publicModelId: id(row.public_model_id) }),
  });
}

const catalogSql = `
  SELECT g.id AS group_id,g.name AS group_name,g.version AS group_version,
    g.billing_multiplier AS billing_multiplier,m.public_model_id,m.sell_prices_json
  FROM user_group_access access
  JOIN users u ON u.id=access.user_id
  JOIN groups g ON g.id=access.group_id
  JOIN channel_groups cg ON cg.group_id=g.id
  JOIN channels c ON c.id=cg.channel_id AND c.status='active'
  JOIN channel_models cm ON cm.channel_id=c.id AND cm.protocol IN ('chat','responses','messages')
  JOIN models m ON m.public_model_id=cm.public_model_id AND m.status='active'
  WHERE access.user_id=? AND u.status='active' AND g.status='active'
    AND access.created_at<=? AND u.created_at<=? AND g.created_at<=?
  GROUP BY g.id,g.name,g.version,g.billing_multiplier,m.public_model_id,m.sell_prices_json
  ORDER BY CASE WHEN g.id=u.group_id THEN 0 ELSE 1 END,g.name,g.id,m.public_model_id`;

async function readCatalog(database: D1Database, userId: string, now: number): Promise<CatalogRow[]> {
  const owner = id(userId);
  try {
    return (await prepare<CatalogRow>(database, catalogSql, [owner, safeInteger(now, 0), now, now]).all()).rows;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('service_unavailable', { cause: error });
  }
}

export async function listAuthorizedChatModels(database: D1Database, userId: string, now = Date.now()): Promise<{ items: ChatGroup[] }> {
  const groups = new Map<string, ChatGroup>();
  for (const row of await readCatalog(database, userId, now)) {
    const existing = groups.get(row.group_id);
    const model: ChatModel = Object.freeze({ publicModelId: id(row.public_model_id), sellPrices: sellPrices(row.sell_prices_json) });
    if (existing === undefined) {
      groups.set(row.group_id, { id: id(row.group_id), name: row.group_name, billingMultiplier: normalizeBillingMultiplier(row.billing_multiplier), models: [model] });
    } else if (!existing.models.some(item => item.publicModelId === model.publicModelId)) {
      groups.set(row.group_id, { ...existing, models: [...existing.models, model] });
    }
  }
  return { items: [...groups.values()].map(group => Object.freeze({ ...group, models: Object.freeze([...group.models]) })) };
}

/** Re-checks group/model access on every send.  A catalogue entry cached by a
 * browser is never treated as an authorization grant. */
export async function authorizeChatSelection(database: D1Database, userId: string, groupId: string, modelId: string,
  now = Date.now()): Promise<AuthorizedChatSelection> {
  const owner = id(userId);
  const group = id(groupId);
  const model = id(modelId);
  const values = [owner, group, model];
  const query = `
    SELECT g.id AS group_id,g.name AS group_name,g.version AS group_version,
      g.billing_multiplier AS billing_multiplier,m.public_model_id
    FROM user_group_access access
    JOIN users u ON u.id=access.user_id
    JOIN groups g ON g.id=access.group_id
    JOIN channel_groups cg ON cg.group_id=g.id
    JOIN channels c ON c.id=cg.channel_id AND c.status='active'
    JOIN channel_models cm ON cm.channel_id=c.id AND cm.protocol IN ('chat','responses','messages')
    JOIN models m ON m.public_model_id=cm.public_model_id AND m.status='active'
    WHERE access.user_id=? AND access.group_id=? AND m.public_model_id=?
      AND u.status='active' AND g.status='active'
      AND access.created_at<=? AND u.created_at<=? AND g.created_at<=?
    GROUP BY g.id,g.name,g.version,g.billing_multiplier,m.public_model_id
    LIMIT 1`;
  try {
    const row = await prepare<AuthorizedCatalogRow>(database, query, [...values, safeInteger(now, 0), now, now]).first();
    if (row === null) throw new ApiError('forbidden');
    const result = rowToSelection(row);
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('service_unavailable', { cause: error });
  }
}
