import type {
  ImageChoice,
  ImageGenerateInput,
  ImageJob,
  ImageModel,
  ImageModelInput,
} from '@cheapai/contracts/images';
import { imageJobSchema, imageModelSchema } from '@cheapai/contracts/images';
import { prepare, batch } from '../db';
import { ApiError } from '../http';
import { formatUnitsToUsd, parseUsdToUnits, unitsToSafeNumber } from '../billing/money';
import { parseBillingMultiplier } from '../billing/pricing';

interface ModelRow {
  id: string;
  name: string;
  channel_id: string;
  upstream_model: string;
  price_units: number;
  sizes_json: string;
  quality: ImageModel['quality'];
  response_format: ImageModel['responseFormat'];
  status: ImageModel['status'];
  version: number;
}
export interface SelectionRow extends ModelRow {
  group_id: string;
  group_name: string;
  billing_multiplier: string;
  group_version: number;
  channel_version: number;
  user_version: number;
  balance_units: number;
  user_concurrency: number;
  user_rpm: number;
  channel_concurrency: number;
  channel_rpm: number;
}
export interface JobRow {
  id: string;
  user_id: string;
  operation_id: string;
  model_id: string;
  model_name: string;
  group_id: string;
  prompt: string;
  size: ImageJob['size'];
  status: ImageJob['status'];
  error: ImageJob['error'];
  price_units: number;
  price_snapshot: string;
  billing_status: ImageJob['billingStatus'];
  asset_key: string | null;
  media_type: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
  execution_snapshot: string | null;
  started_at: number | null;
}
export function modelView(row: ModelRow): ImageModel {
  return imageModelSchema.parse({
    id: row.id,
    name: row.name,
    channelId: row.channel_id,
    upstreamModel: row.upstream_model,
    pricePerImage: formatUnitsToUsd(BigInt(row.price_units)),
    sizes: JSON.parse(row.sizes_json),
    quality: row.quality,
    responseFormat: row.response_format,
    status: row.status,
    version: row.version,
  });
}
export function jobView(row: JobRow): ImageJob {
  return imageJobSchema.parse({
    id: row.id,
    operationId: row.operation_id,
    modelId: row.model_id,
    modelName: row.model_name,
    groupId: row.group_id,
    prompt: row.prompt,
    size: row.size,
    status: row.status,
    error: row.error,
    priceUnits: String(row.price_units),
    billingStatus: row.billing_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
export function quotedUnits(row: Pick<SelectionRow, 'price_units' | 'billing_multiplier'>): number {
  const m = parseBillingMultiplier(row.billing_multiplier);
  return unitsToSafeNumber(
    (BigInt(row.price_units) * m.numerator + m.denominator / 2n) / m.denominator,
  );
}

const authorized = `FROM image_models m
  JOIN channels c ON c.id=m.channel_id AND c.status='active' AND c.deleted_at IS NULL
  JOIN channel_groups cg ON cg.channel_id=c.id
  JOIN groups g ON g.id=cg.group_id AND g.status='active'
  JOIN user_group_access a ON a.group_id=g.id
  JOIN users u ON u.id=a.user_id AND u.status='active'
  JOIN groups owner_group ON owner_group.id=u.group_id AND owner_group.status='active'
  WHERE u.id=? AND m.status='active'`;
const selection = `SELECT m.*,g.id AS group_id,g.name AS group_name,g.billing_multiplier,g.version AS group_version,
  c.config_version AS channel_version,u.version AS user_version,u.balance_units,
  u.concurrency_limit AS user_concurrency,u.rpm_limit AS user_rpm,
  c.concurrency_limit AS channel_concurrency,c.rpm_limit AS channel_rpm ${authorized}`;

export async function choices(db: D1Database, userId: string): Promise<ImageChoice[]> {
  const rows = (
    await prepare<SelectionRow>(db, `${selection} ORDER BY m.name,g.name,m.id,g.id`, [userId]).all()
  ).rows;
  return rows.map((row) => ({
    modelId: row.id,
    name: row.name,
    groupId: row.group_id,
    groupName: row.group_name,
    sizes: modelView(row).sizes,
    priceUnits: String(quotedUnits(row)),
  }));
}
export async function authorize(
  db: D1Database,
  userId: string,
  input: ImageGenerateInput,
): Promise<SelectionRow> {
  const row = await prepare<SelectionRow>(db, `${selection} AND m.id=? AND g.id=?`, [
    userId,
    input.modelId,
    input.groupId,
  ]).first();
  if (!row) throw new ApiError('forbidden');
  if (!modelView(row).sizes.includes(input.size)) throw new ApiError('invalid_request');
  if (row.balance_units < quotedUnits(row)) throw new ApiError('insufficient_balance');
  return row;
}
export async function listModels(db: D1Database): Promise<ImageModel[]> {
  return (
    await prepare<ModelRow>(db, 'SELECT * FROM image_models ORDER BY created_at DESC,id DESC').all()
  ).rows.map(modelView);
}
export async function saveModel(
  db: D1Database,
  actorId: string,
  input: ImageModelInput,
  now: number,
  existing?: { id: string; version: number },
): Promise<ImageModel> {
  const price = unitsToSafeNumber(parseUsdToUnits(input.pricePerImage));
  const channel = await prepare(db, 'SELECT id FROM channels WHERE id=? AND deleted_at IS NULL', [
    input.channelId,
  ]).first();
  if (!channel) throw new ApiError('invalid_request');
  const id = existing?.id ?? crypto.randomUUID();
  const args = [
    input.name,
    input.channelId,
    input.upstreamModel,
    price,
    JSON.stringify(input.sizes),
    input.quality,
    input.responseFormat,
    input.status,
  ];
  const write = existing
    ? prepare(
        db,
        `UPDATE image_models SET name=?,channel_id=?,upstream_model=?,price_units=?,sizes_json=?,quality=?,response_format=?,status=?,version=version+1,updated_at=? WHERE id=? AND version=?`,
        [...args, now, id, existing.version],
      )
    : prepare(
        db,
        `INSERT INTO image_models(name,channel_id,upstream_model,price_units,sizes_json,quality,response_format,status,version,created_at,updated_at,id) VALUES(?,?,?,?,?,?,?,?,1,?,?,?)`,
        [...args, now, now, id],
      );
  const results = await batch(db, [
    write,
    prepare(
      db,
      `INSERT INTO admin_audit(id,actor_id,action,target_type,target_id,redacted_change_json,operation_id,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE changes()=1`,
      [
        crypto.randomUUID(),
        actorId,
        existing ? 'image_model.update' : 'image_model.create',
        'image_model',
        id,
        JSON.stringify(input),
        crypto.randomUUID(),
        now,
      ],
    ),
  ]);
  if (results[0].changes !== 1) throw new ApiError('conflict');
  return {
    ...input,
    pricePerImage: formatUnitsToUsd(BigInt(price)),
    id,
    version: (existing?.version ?? 0) + 1,
  };
}

export async function getJob(db: D1Database, userId: string, id: string): Promise<JobRow | null> {
  return prepare<JobRow>(db, 'SELECT * FROM image_generations WHERE user_id=? AND id=?', [
    userId,
    id,
  ]).first();
}
export async function byOperation(
  db: D1Database,
  userId: string,
  operationId: string,
): Promise<JobRow | null> {
  return prepare<JobRow>(db, 'SELECT * FROM image_generations WHERE user_id=? AND operation_id=?', [
    userId,
    operationId,
  ]).first();
}
export function verifyReplay(row: JobRow, input: ImageGenerateInput): void {
  if (
    row.model_id !== input.modelId ||
    row.group_id !== input.groupId ||
    row.prompt !== input.prompt ||
    row.size !== input.size
  )
    throw new ApiError('conflict');
}
export async function register(
  db: D1Database,
  userId: string,
  input: ImageGenerateInput,
  config: SelectionRow,
  id: string,
  now: number,
): Promise<{ row: JobRow; created: boolean }> {
  const price = quotedUnits(config);
  const snapshot = JSON.stringify({
    modelId: config.id,
    modelName: config.name,
    channelId: config.channel_id,
    upstreamModel: config.upstream_model,
    version: config.version,
    pricePerImageUnits: String(config.price_units),
    billingMultiplier: config.billing_multiplier,
    size: input.size,
    quality: config.quality,
    priceUnits: String(price),
  });
  const inserted = await prepare(
    db,
    `INSERT INTO image_generations(id,user_id,operation_id,model_id,model_name,group_id,prompt,size,status,price_units,price_snapshot,billing_status,created_at,updated_at,expires_at,execution_snapshot)
    SELECT ?,?,?,m.id,m.name,g.id,?,?,'generating',?,?,'unbilled',?,?,?,? ${authorized}
    AND m.id=? AND g.id=? AND m.version=? AND c.config_version=? AND g.version=? AND u.version=? AND u.balance_units>=?
    ON CONFLICT(user_id,operation_id) DO NOTHING`,
    [
      id,
      userId,
      input.operationId,
      input.prompt,
      input.size,
      price,
      snapshot,
      now,
      now,
      now + 600_000,
      JSON.stringify(config),
      userId,
      input.modelId,
      input.groupId,
      config.version,
      config.channel_version,
      config.group_version,
      config.user_version,
      price,
    ],
  ).run();
  const row = await byOperation(db, userId, input.operationId);
  if (!row) throw new ApiError('conflict');
  verifyReplay(row, input);
  return { row, created: inserted.changes === 1 };
}
export async function markFailure(
  db: D1Database,
  row: JobRow,
  error: NonNullable<ImageJob['error']>,
  now: number,
): Promise<void> {
  await prepare(
    db,
    `UPDATE image_generations SET status='failed',error=?,updated_at=? WHERE id=? AND user_id=? AND status='generating'`,
    [error, now, row.id, row.user_id],
  ).run();
}
async function settleImage(db: D1Database, row: JobRow, now: number): Promise<void> {
  // The unique operation and SQL triggers commit the charge and balance exactly once.
  await prepare(
    db,
    `INSERT INTO billing_entries(id,operation_id,kind,user_id,image_generation_id,currency,delta_units,fingerprint,usage_snapshot,price_snapshot,reason,created_at)
    SELECT ?,?,'image_generation',user_id,id,'USD',-price_units,?, '{"images":1}',price_snapshot,'图片生成',?
    FROM image_generations WHERE id=? AND user_id=? AND status='completed' AND billing_status='pending'
      AND NOT EXISTS(SELECT 1 FROM billing_entries WHERE image_generation_id=image_generations.id)`,
    [crypto.randomUUID(), `image:${row.id}`, `image:${row.id}`, now, row.id, row.user_id],
  ).run();
}
export async function recover(db: D1Database, row: JobRow, now: number): Promise<JobRow> {
  if (row.status === 'generating' && row.expires_at <= now)
    // Recheck the deadline in SQL: an alarm may have started since this row was read.
    await prepare(
      db,
      `UPDATE image_generations SET
      status='failed',
      error=CASE WHEN execution_snapshot IS NOT NULL AND started_at IS NULL THEN 'provider_unavailable' ELSE 'delivery_failed' END,
      updated_at=? WHERE id=? AND user_id=? AND status='generating' AND expires_at<=?`,
      [now, row.id, row.user_id, now],
    ).run();
  if (row.status === 'completed' && row.billing_status === 'pending') {
    try {
      await settleImage(db, row, now);
    } catch {
      // A temporary accounting failure must not hide an already saved result.
      // The scheduled maintenance task retries this same charge.
    }
  }
  return (await getJob(db, row.user_id, row.id)) ?? row;
}
export async function history(db: D1Database, userId: string, cursor: string | null) {
  let after: [number, string] | null = null;
  if (cursor) {
    try {
      const value: unknown = JSON.parse(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')));
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        value[0] !== userId ||
        !Number.isSafeInteger(value[1]) ||
        typeof value[2] !== 'string'
      )
        throw new Error();
      after = [value[1], value[2]];
    } catch {
      throw new ApiError('invalid_request');
    }
  }
  const rows = (
    await prepare<JobRow>(
      db,
      `SELECT * FROM image_generations WHERE user_id=? ${after ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT 21`,
      [userId, ...(after ? [after[0], after[0], after[1]] : [])],
    ).all()
  ).rows;
  const items = rows.slice(0, 20).map(jobView);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > 20 && last
        ? btoa(JSON.stringify([userId, last.createdAt, last.id]))
            .replaceAll('+', '-')
            .replaceAll('/', '_')
            .replace(/=+$/u, '')
        : null,
  };
}
