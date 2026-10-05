import { prepare } from '../db';
import { ApiError, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../http';
import type {
  ChatConversationRow,
  Conversation,
  ConversationListOptions,
  ConversationPage,
  CreateConversationInput,
  UpdateConversationInput,
} from './types';

const conversationColumns = 'id,user_id,title,group_id,model_id,version,created_at,updated_at';
const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 256;
const MAX_TIME = Number.MAX_SAFE_INTEGER;

function invalid(): never { throw new ApiError('invalid_request'); }

export function requireChatId(value: unknown, label = 'chat ID'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value;
}

export function requireChatText(value: unknown, label = 'chat text', max = 1_048_576): string {
  if (typeof value !== 'string' || value.length > max || new TextEncoder().encode(value).byteLength > max || /\u0000/u.test(value)) invalid();
  return value;
}

export function requireChatTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_TIME) invalid();
  return value;
}

export function requireChatVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= MAX_TIME) invalid();
  return value;
}

export function requireOperationId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH
    || !/^[A-Za-z0-9_.:-]+$/u.test(value)) invalid();
  return value;
}

export function optionalChatId(value: unknown, label = 'chat ID'): string | null {
  if (value === null || value === undefined) return null;
  return requireChatId(value, label);
}

function title(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_TITLE_LENGTH || new TextEncoder().encode(value).byteLength > 1024 || /\u0000/u.test(value)) invalid();
  return value.trim();
}

function mapConversation(row: ChatConversationRow): Conversation {
  if (typeof row.id !== 'string' || typeof row.user_id !== 'string' || typeof row.title !== 'string'
    || !Number.isSafeInteger(row.version) || row.version < 1
    || !Number.isSafeInteger(row.created_at) || row.created_at < 0
    || !Number.isSafeInteger(row.updated_at) || row.updated_at < row.created_at
    || (row.group_id !== null && typeof row.group_id !== 'string')
    || (row.model_id !== null && typeof row.model_id !== 'string')) {
    throw new ApiError('service_unavailable');
  }
  return Object.freeze({ id: row.id, title: row.title, groupId: row.group_id, modelId: row.model_id,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at });
}

function cursorEncode(value: readonly unknown[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function cursorDecode(value: string): [number, string] {
  try {
    if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const encoded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const tuple: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!Array.isArray(tuple) || tuple.length !== 2 || cursorEncode(tuple) !== value
      || !Number.isSafeInteger(tuple[0]) || (tuple[0] as number) < 0
      || typeof tuple[1] !== 'string' || !tuple[1].length || tuple[1].length > MAX_ID_LENGTH) throw new Error();
    return [tuple[0] as number, tuple[1] as string];
  } catch { throw new ApiError('invalid_request'); }
}

export async function createConversation(
  database: D1Database,
  trustedUserId: string,
  input: CreateConversationInput,
): Promise<Conversation> {
  const userId = requireChatId(trustedUserId, 'user ID');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  const id = input.id === undefined ? crypto.randomUUID() : requireChatId(input.id, 'conversation ID');
  const name = input.title === undefined ? '' : title(input.title);
  const groupId = optionalChatId(input.groupId, 'group ID');
  const modelId = optionalChatId(input.modelId, 'model ID');
  const now = requireChatTime(input.now);
  try {
    const result = await prepare<ChatConversationRow>(database, `
      INSERT INTO chat_conversations
        (id,user_id,title,group_id,model_id,version,created_at,updated_at)
      SELECT ?,u.id,?,?,?,1,?,?
      FROM users u WHERE u.id=? AND u.status='active'
      RETURNING ${conversationColumns}`, [id, name, groupId, modelId, now, now, userId]).run();
    if (result.changes !== 1 || !result.rows[0]) throw new ApiError('forbidden');
    return mapConversation(result.rows[0]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.message.includes('FOREIGN KEY constraint failed')) throw new ApiError('invalid_request');
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new ApiError('conflict');
    throw new ApiError('service_unavailable', { cause: error });
  }
}

/** Reads are always scoped by the trusted authenticated user ID. */
export async function getConversation(
  database: D1Database,
  trustedUserId: string,
  conversationId: string,
): Promise<Conversation | null> {
  const userId = requireChatId(trustedUserId, 'user ID');
  const id = requireChatId(conversationId, 'conversation ID');
  const row = await prepare<ChatConversationRow>(database,
    `SELECT ${conversationColumns} FROM chat_conversations WHERE id=? AND user_id=?`, [id, userId]).first();
  return row ? mapConversation(row) : null;
}

export async function listConversations(
  database: D1Database,
  trustedUserId: string,
  options: ConversationListOptions = {},
): Promise<ConversationPage> {
  const userId = requireChatId(trustedUserId, 'user ID');
  if (options === null || typeof options !== 'object' || Array.isArray(options)) invalid();
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) invalid();
  let afterTime: number | null = null;
  let afterId: string | null = null;
  if (options.cursor !== undefined && options.cursor !== null) [afterTime, afterId] = cursorDecode(options.cursor);
  const result = await prepare<ChatConversationRow>(database, `
    SELECT ${conversationColumns} FROM chat_conversations
    WHERE user_id=? AND (? IS NULL OR updated_at<? OR (updated_at=? AND id<?))
    ORDER BY updated_at DESC,id DESC LIMIT ?`,
  [userId, afterTime, afterTime, afterTime, afterId, limit + 1]).all();
  const checked = result.rows.map(mapConversation);
  const items = checked.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: checked.length > limit && last ? cursorEncode([last.updatedAt, last.id]) : null };
}

export async function updateConversation(
  database: D1Database,
  trustedUserId: string,
  conversationId: string,
  expectedVersion: number,
  patch: UpdateConversationInput,
  now: number,
): Promise<Conversation> {
  const userId = requireChatId(trustedUserId, 'user ID');
  const id = requireChatId(conversationId, 'conversation ID');
  const version = requireChatVersion(expectedVersion);
  const timestamp = requireChatTime(now);
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) invalid();
  const fields = Object.keys(patch);
  if (fields.length === 0 || fields.some(field => !['title', 'groupId', 'modelId'].includes(field))) invalid();
  const current = await getConversation(database, userId, id);
  if (!current) throw new ApiError('not_found');
  if (current.version !== version) throw new ApiError('conflict');
  const nextTitle = Object.hasOwn(patch, 'title') ? title(patch.title) : current.title;
  const nextGroup = Object.hasOwn(patch, 'groupId') ? optionalChatId(patch.groupId, 'group ID') : current.groupId;
  const nextModel = Object.hasOwn(patch, 'modelId') ? optionalChatId(patch.modelId, 'model ID') : current.modelId;
  if (version >= MAX_TIME) throw new ApiError('conflict');
  try {
    const result = await prepare<ChatConversationRow>(database, `
      UPDATE chat_conversations SET title=?,group_id=?,model_id=?,version=version+1,updated_at=max(updated_at,?)
      WHERE id=? AND user_id=? AND version=? AND version<?
      RETURNING ${conversationColumns}`, [nextTitle, nextGroup, nextModel, timestamp, id, userId, version, MAX_TIME]).run();
    if (result.changes === 0 || !result.rows[0]) throw new ApiError('conflict');
    return mapConversation(result.rows[0]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.message.includes('FOREIGN KEY constraint failed')) throw new ApiError('invalid_request');
    throw new ApiError('service_unavailable', { cause: error });
  }
}

export async function deleteConversation(
  database: D1Database,
  trustedUserId: string,
  conversationId: string,
  expectedVersion: number,
): Promise<boolean> {
  const userId = requireChatId(trustedUserId, 'user ID');
  const id = requireChatId(conversationId, 'conversation ID');
  const version = requireChatVersion(expectedVersion);
  const current = await getConversation(database, userId, id);
  if (!current) throw new ApiError('not_found');
  if (current.version !== version) throw new ApiError('conflict');
  const running = await prepare<{ id: string }>(database, `
    SELECT m.id FROM chat_messages m
    WHERE m.conversation_id=? AND m.role='assistant' AND m.status='generating' LIMIT 1`, [id]).first();
  if (running) throw new ApiError('conflict');
  try {
    const result = await prepare(database,
      'DELETE FROM chat_conversations WHERE id=? AND user_id=? AND version=? AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE conversation_id=? AND role=\'assistant\' AND status=\'generating\')',
      [id, userId, version, id]).run();
    // D1 counts ON DELETE CASCADE child rows in meta.changes, so a successful
    // conversation delete may report more than one changed row.
    if (result.changes < 1) throw new ApiError('conflict');
    return true;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('service_unavailable', { cause: error });
  }
}

/** Internal ownership check used by message mutations. */
export async function requireConversationOwner(
  database: D1Database,
  trustedUserId: string,
  conversationId: string,
): Promise<Conversation> {
  const conversation = await getConversation(database, trustedUserId, conversationId);
  if (!conversation) throw new ApiError('not_found');
  return conversation;
}

// Explicit aliases make the repository readable from route code while keeping
// the storage contract stable if a caller prefers “read” terminology.
export const readConversation = getConversation;
export const patchConversation = updateConversation;
