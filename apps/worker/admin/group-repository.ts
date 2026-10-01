import { batch, prepare } from '../db';
import { ApiError, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../http';
import { isValidBillingMultiplier } from '../billing/pricing';
import { buildAuditStatement } from './audit';

export interface GroupView { id: string; name: string; status: 'active' | 'disabled'; version: number; createdAt: number; updatedAt: number; channelIds: string[]; billingMultiplier: string }
export interface CreateGroupInput { name: string; status?: 'active' | 'disabled'; channelIds?: string[]; billingMultiplier?: string }
export type GroupPatch = Partial<CreateGroupInput>;
export interface GroupAuditContext { actorId: string; operationId: string; now: number }
export interface GroupPageOptions { limit?: number; cursor?: string; status?: 'active' | 'disabled' }
interface GroupRow { id: string; name: string; status: 'active' | 'disabled'; version: number; created_at: number; updated_at: number; channel_ids: string; billing_multiplier: string }
const projection = `g.id,g.name,g.status,g.version,g.created_at,g.updated_at,
  (SELECT json_group_array(channel_id) FROM (SELECT channel_id FROM channel_groups WHERE group_id=g.id ORDER BY channel_id)) AS channel_ids,
  g.billing_multiplier`;
const invalid = (): never => { throw new ApiError('invalid_request'); };
function id(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value)) invalid();
  return value as string;
}
function integer(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) invalid();
  return value as number;
}
function status(value: unknown): 'active' | 'disabled' {
  if (value !== 'active' && value !== 'disabled') invalid();
  return value as 'active' | 'disabled';
}
function multiplier(value: unknown): string {
  if (!isValidBillingMultiplier(value)) invalid();
  return value as string;
}
function input(value: unknown): GroupPatch {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const result: GroupPatch = {};
  for (const key of Reflect.ownKeys(value as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) invalid();
    const field: unknown = descriptor!.value;
    if (key === 'name') {
      if (typeof field !== 'string' || !field.trim() || field.length > 128 || /[\u0000-\u001f\u007f]/.test(field)) invalid();
      result.name = (field as string).trim();
    } else if (key === 'status') result.status = status(field);
    else if (key === 'channelIds') {
      if (!Array.isArray(field) || field.length > 100) invalid();
      result.channelIds = [...new Set((field as unknown[]).map(id))].sort();
    } else if (key === 'billingMultiplier') result.billingMultiplier = multiplier(field);
    else invalid();
  }
  return result;
}
function view(row: GroupRow): GroupView {
  return { id: row.id, name: row.name, status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    channelIds: JSON.parse(row.channel_ids) as string[], billingMultiplier: row.billing_multiplier };
}
function auditContext(value: GroupAuditContext): GroupAuditContext {
  return { actorId: id(value.actorId), operationId: id(value.operationId), now: integer(value.now, 0) };
}
function actorGuard(database: D1Database, actorId: string) {
  return prepare(database, `SELECT CASE WHEN EXISTS(SELECT 1 FROM users u JOIN groups g ON g.id=u.group_id
    WHERE u.id=? AND u.role='admin' AND u.status='active' AND g.status='active') THEN 1
    ELSE json_extract('{}','group_actor_forbidden') END`, [actorId]);
}
function changedGuard(database: D1Database) {
  return prepare(database, "SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('{}','group_write_conflict') END");
}
function writeError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof Error) {
    if (error.message.includes('group_actor_forbidden')) throw new ApiError('forbidden');
    if (error.message.includes('group_write_conflict') || error.message.includes('UNIQUE constraint failed: groups.name')) throw new ApiError('conflict');
    if (error.message.includes('FOREIGN KEY constraint failed')) throw new ApiError('invalid_request');
  }
  throw new ApiError('service_unavailable');
}
function audit(database: D1Database, context: GroupAuditContext, groupId: string, action: string, changes: unknown) {
  return buildAuditStatement(database, { actor_id: context.actorId, operation_id: context.operationId, created_at: context.now,
    target_type: 'group', target_id: groupId, action, changes });
}
function relationAudits(database: D1Database, context: GroupAuditContext, groupId: string, before: string[], after: string[]) {
  return [
    ...before.filter(channel => !after.includes(channel)).map(channel => audit(database, context, groupId, 'group.channel.detach', { group_id: groupId, channel_id: channel })),
    ...after.filter(channel => !before.includes(channel)).map(channel => audit(database, context, groupId, 'group.channel.attach', { group_id: groupId, channel_id: channel })),
  ];
}

export async function getGroupById(database: D1Database, groupId: string): Promise<GroupView | null> {
  const row = await prepare<GroupRow>(database, `SELECT ${projection} FROM groups g WHERE g.id=?`, [id(groupId)]).first();
  return row ? view(row) : null;
}

export async function createGroup(database: D1Database, values: CreateGroupInput, context: GroupAuditContext): Promise<GroupView> {
  const fields = input(values);
  if (!fields.name) invalid();
  const groupId = crypto.randomUUID();
  const state = fields.status ?? 'active';
  const channels = fields.channelIds ?? [];
  const billing = fields.billingMultiplier ?? '1';
  const event = auditContext(context);
  try {
    const result = await batch(database, [
      actorGuard(database, event.actorId),
      prepare<GroupRow>(database, `INSERT INTO groups(id,name,status,version,created_at,updated_at,billing_multiplier) VALUES(?,?,?,1,?,?,?)
        RETURNING *, '[]' AS channel_ids`, [groupId, fields.name!, state, event.now, event.now, billing]),
      changedGuard(database),
      prepare(database, 'INSERT INTO channel_groups(channel_id,group_id) SELECT value,? FROM json_each(?)', [groupId, JSON.stringify(channels)]),
      audit(database, event, groupId, 'group.create', { status: state, version: 1, name_changed: true, billing_multiplier: billing }),
      ...relationAudits(database, event, groupId, [], channels),
    ] as const);
    const row = result[1].rows[0];
    if (!row) throw new ApiError('service_unavailable');
    return { ...view(row), channelIds: channels, billingMultiplier: billing };
  } catch (error) { return writeError(error); }
}

/** Replaces channelIds as a set. users.group_id is the only membership source.
 * Disabling the configured default group is rejected; move that setting first.
 * A disable must also leave an active admin in another active group.
 */
export async function updateGroup(database: D1Database, groupId: string, expectedVersion: number, patch: GroupPatch, context: GroupAuditContext): Promise<GroupView> {
  id(groupId); integer(expectedVersion, 1);
  if (expectedVersion === Number.MAX_SAFE_INTEGER) throw new ApiError('conflict');
  const fields = input(patch);
  if (!Object.keys(fields).length) invalid();
  const event = auditContext(context);
  const current = await getGroupById(database, groupId);
  if (!current) throw new ApiError('not_found');
  if (current.version !== expectedVersion) throw new ApiError('conflict');
  const state = fields.status ?? current.status;
  const channels = fields.channelIds ?? current.channelIds;
  const billing = fields.billingMultiplier ?? current.billingMultiplier;
  try {
    const result = await batch(database, [
      actorGuard(database, event.actorId),
      prepare<GroupRow>(database, `UPDATE groups SET name=?,status=?,billing_multiplier=?,version=version+1,updated_at=max(updated_at,?)
        WHERE id=? AND version=? AND (?<>'disabled' OR (
          NOT EXISTS(SELECT 1 FROM settings WHERE key='default_group_id' AND json_extract(value_json,'$')=?)
          AND EXISTS(SELECT 1 FROM users u JOIN groups g ON g.id=u.group_id
            WHERE u.role='admin' AND u.status='active' AND g.status='active' AND g.id<>?)
        )) RETURNING *, '[]' AS channel_ids`,
      [fields.name ?? current.name, state, billing, event.now, groupId, expectedVersion, state, groupId, groupId]),
      changedGuard(database),
      ...(fields.channelIds === undefined ? [] : [
        prepare(database, 'DELETE FROM channel_groups WHERE group_id=?', [groupId]),
        prepare(database, 'INSERT INTO channel_groups(channel_id,group_id) SELECT value,? FROM json_each(?)', [groupId, JSON.stringify(channels)]),
      ]),
      audit(database, event, groupId, 'group.update', { before: { status: current.status, version: current.version, billing_multiplier: current.billingMultiplier },
        after: { status: state, version: expectedVersion + 1, billing_multiplier: billing }, name_changed: fields.name !== undefined,
        billing_multiplier_changed: fields.billingMultiplier !== undefined }),
      ...relationAudits(database, event, groupId, current.channelIds, channels),
    ] as const);
    const row = result[1].rows[0];
    if (!row) throw new ApiError('service_unavailable');
    return { ...view(row), channelIds: channels, billingMultiplier: billing };
  } catch (error) { return writeError(error); }
}

export async function listGroups(database: D1Database, options: GroupPageOptions = {}): Promise<{ items: GroupView[]; nextCursor: string | null }> {
  const limit = integer(options.limit ?? DEFAULT_PAGE_LIMIT, 1);
  if (limit > MAX_PAGE_LIMIT) invalid();
  const filter = options.status === undefined ? null : status(options.status);
  let cursorTime: number | null = null;
  let cursorId: string | null = null;
  if (options.cursor !== undefined) {
    try {
      if (typeof options.cursor !== 'string' || options.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) invalid();
      const parsed: unknown = JSON.parse(atob(options.cursor.replace(/-/g, '+').replace(/_/g, '/')));
      if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[2] !== filter) invalid();
      cursorTime = integer((parsed as unknown[])[0], 0); cursorId = id((parsed as unknown[])[1]);
    } catch { invalid(); }
  }
  const result = await prepare<GroupRow>(database, `SELECT ${projection} FROM groups g
    WHERE (? IS NULL OR g.status=?) AND (? IS NULL OR g.created_at<? OR (g.created_at=? AND g.id<?))
    ORDER BY g.created_at DESC,g.id DESC LIMIT ?`, [filter, filter, cursorTime, cursorTime, cursorTime, cursorId, limit + 1]).all();
  const items = result.rows.slice(0, limit).map(view);
  const last = items[items.length - 1];
  const nextCursor = result.rows.length > limit && last
    ? btoa(JSON.stringify([last.createdAt, last.id, filter])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null;
  return { items, nextCursor };
}
