import { batch, prepare } from '../db';
import { ApiError } from '../http';
import {
  createConversation as createConversationRecord,
  deleteConversation as deleteConversationRecord,
  getConversation as getConversationRecord,
  listConversations as listConversationRecords,
  requireChatId,
  requireChatText,
  requireChatTime,
  requireChatVersion,
  requireConversationOwner,
  requireOperationId,
  optionalChatId,
  updateConversation as updateConversationRecord,
} from './repository';
import type {
  AcceptRegenerateInput,
  AcceptSendInput,
  AttachRequestInput,
  ChatGenerationRecoveryResult,
  ChatMessageRow,
  ChatMutationResult,
  CheckpointInput,
  Conversation,
  ConversationWithMessages,
  FinalizeInput,
  Message,
  SelectMessageVersionInput,
  SelectMessageVersionResult,
} from './types';

const messageColumns = 'm.id,m.conversation_id,m.turn_index,m.role,m.content,m.status,m.variant,m.selected,m.operation_id,m.request_id,m.group_id,m.model_id,m.created_at,m.updated_at';
const messageReturningColumns = 'id,conversation_id,turn_index,role,content,status,variant,selected,operation_id,request_id,group_id,model_id,created_at,updated_at';
const MAX_TIME = Number.MAX_SAFE_INTEGER;
/**
 * A generation without a registered request is safe to abandon only after a
 * bounded grace period.  Registered requests can legitimately spend longer
 * upstream and are recovered exclusively from their request terminal state.
 */
export const UNREGISTERED_GENERATION_TIMEOUT_MS = 5 * 60 * 1000;
/** Give the stream bridge a short window to persist its last buffered text
 * after the request lifecycle reaches a terminal state. */
export const TERMINAL_REQUEST_SETTLE_GRACE_MS = 5 * 1000;

function invalid(): never { throw new ApiError('invalid_request'); }

function sameNullable(a: string | null, b: string | null): boolean { return a === b; }

function mapMessage(row: ChatMessageRow): Message {
  if (typeof row.id !== 'string' || typeof row.conversation_id !== 'string' || !Number.isSafeInteger(row.turn_index)
    || row.turn_index < 1 || !['user', 'assistant'].includes(row.role) || typeof row.content !== 'string'
    || !['generating', 'completed', 'stopped', 'failed'].includes(row.status)
    || !Number.isSafeInteger(row.variant) || row.variant < 1 || (row.selected !== 0 && row.selected !== 1)
    || (row.request_id !== null && typeof row.request_id !== 'string')
    || (row.group_id !== null && typeof row.group_id !== 'string')
    || (row.model_id !== null && typeof row.model_id !== 'string')
    || !Number.isSafeInteger(row.created_at) || row.created_at < 0
    || !Number.isSafeInteger(row.updated_at) || row.updated_at < row.created_at) {
    throw new ApiError('service_unavailable');
  }
  return Object.freeze({ id: row.id, conversationId: row.conversation_id, turnIndex: row.turn_index,
    role: row.role, content: row.content, status: row.status, variant: row.variant,
    selected: row.selected === 1, requestId: row.request_id, groupId: row.group_id, modelId: row.model_id,
    createdAt: row.created_at, updatedAt: row.updated_at });
}

async function messagesForConversation(
  database: D1Database,
  trustedUserId: string,
  conversationId: string,
  selectedOnly = false,
): Promise<Message[]> {
  const userId = requireChatId(trustedUserId, 'user ID');
  const id = requireChatId(conversationId, 'conversation ID');
  const result = await prepare<ChatMessageRow>(database, `
    SELECT ${messageColumns} FROM chat_messages m
    JOIN chat_conversations c ON c.id=m.conversation_id AND c.user_id=?
    WHERE m.conversation_id=? ${selectedOnly ? 'AND m.selected=1' : ''}
    ORDER BY m.turn_index ASC,CASE WHEN m.role='user' THEN 0 ELSE 1 END ASC,m.variant ASC,m.id ASC`,
  [userId, id]).all();
  return result.rows.map(mapMessage);
}

export async function listMessages(
  database: D1Database,
  trustedUserId: string,
  conversationId: string,
): Promise<readonly Message[]> {
  await requireConversationOwner(database, trustedUserId, conversationId);
  return messagesForConversation(database, trustedUserId, conversationId);
}

export async function getConversationWithMessages(
  database: D1Database,
  trustedUserId: string,
  conversationId: string,
  now?: number,
): Promise<ConversationWithMessages | null> {
  const conversation = await getConversationRecord(database, trustedUserId, conversationId);
  if (!conversation) return null;
  // A worker restart can leave the assistant row in `generating` after the
  // request itself reached a terminal state. Reconcile that durable evidence
  // before exposing history, so refresh never creates a permanent spinner.
  await reconcileGeneration(database, trustedUserId, conversationId, now);
  const refreshed = await getConversationRecord(database, trustedUserId, conversationId);
  if (!refreshed) return null;
  return Object.freeze({ conversation: refreshed, messages: await messagesForConversation(database, trustedUserId, conversationId) });
}

async function bundle(database: D1Database, userId: string, conversationId: string): Promise<ConversationWithMessages> {
  const conversation = await requireConversationOwner(database, userId, conversationId);
  return Object.freeze({ conversation, messages: await messagesForConversation(database, userId, conversationId) });
}

async function messageById(
  database: D1Database,
  trustedUserId: string,
  messageId: string,
): Promise<Message | null> {
  const userId = requireChatId(trustedUserId, 'user ID');
  const id = requireChatId(messageId, 'message ID');
  const row = await prepare<ChatMessageRow>(database, `
    SELECT ${messageColumns} FROM chat_messages m
    JOIN chat_conversations c ON c.id=m.conversation_id AND c.user_id=?
    WHERE m.id=?`, [userId, id]).first();
  return row ? mapMessage(row) : null;
}

async function userForTurn(database: D1Database, userId: string, conversationId: string, turnIndex: number): Promise<Message | null> {
  const result = await prepare<ChatMessageRow>(database, `
    SELECT ${messageColumns} FROM chat_messages m
    JOIN chat_conversations c ON c.id=m.conversation_id AND c.user_id=?
    WHERE m.conversation_id=? AND m.turn_index=? AND m.role='user'`, [userId, conversationId, turnIndex]).first();
  return result ? mapMessage(result) : null;
}

interface OperationRow {
  message: Message;
  conversationId: string;
}

async function assistantByOperation(
  database: D1Database,
  userId: string,
  conversationId: string,
  operationId: string,
): Promise<OperationRow | null> {
  const row = await prepare<ChatMessageRow>(database, `
    SELECT ${messageColumns} FROM chat_messages m
    JOIN chat_conversations c ON c.id=m.conversation_id AND c.user_id=?
    WHERE m.conversation_id=? AND m.operation_id=? AND m.role='assistant'`,
  [userId, conversationId, operationId]).first();
  return row ? { message: mapMessage(row), conversationId } : null;
}

function snippet(content: string): string {
  const firstLine = content.split(/\r?\n/u, 1)[0]!.trim();
  if (firstLine.length <= 80) return firstLine;
  return `${firstLine.slice(0, 77)}…`;
}

function requireMessageMutationText(value: unknown): string {
  return requireChatText(value, 'message content', 1_048_576);
}

function operationResult(
  result: ConversationWithMessages,
  assistant: Message,
  userMessage: Message | null,
  replayed: boolean,
): ChatMutationResult {
  return Object.freeze({ conversation: result.conversation, userMessage, assistantMessage: assistant,
    messages: result.messages, replayed });
}

function operationMatches(assistant: Message, groupId: string | null, modelId: string | null): boolean {
  return sameNullable(assistant.groupId, groupId) && sameNullable(assistant.modelId, modelId);
}

async function replaySend(
  database: D1Database,
  input: AcceptSendInput,
  existing: OperationRow,
): Promise<ChatMutationResult> {
  if (!operationMatches(existing.message, input.groupId, input.modelId)) throw new ApiError('conflict');
  const user = await userForTurn(database, input.userId, input.conversationId, existing.message.turnIndex);
  // Operation IDs are internal and are intentionally not exposed in Message;
  // query the canonical row to distinguish a send from a regenerate.
  const operationUser = await prepare<{ operation_id: string | null }>(database,
    `SELECT operation_id FROM chat_messages WHERE id=? AND role='user'`, [user?.id ?? '']).first();
  if (!operationUser || operationUser.operation_id !== input.operationId) throw new ApiError('conflict');
  if (!user) throw new ApiError('conflict');
  const full = await bundle(database, input.userId, input.conversationId);
  if (user.content !== input.content) throw new ApiError('conflict');
  return operationResult(full, existing.message, user, true);
}

async function replayRegenerate(
  database: D1Database,
  input: AcceptRegenerateInput,
  existing: OperationRow,
): Promise<ChatMutationResult> {
  if (!operationMatches(existing.message, input.groupId, input.modelId)) throw new ApiError('conflict');
  const user = await userForTurn(database, input.userId, input.conversationId, existing.message.turnIndex);
  if (!user) throw new ApiError('conflict');
  const full = await bundle(database, input.userId, input.conversationId);
  return operationResult(full, existing.message, user, true);
}

function guard(database: D1Database, name: string) {
  return prepare(database, `SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('{}','${name}') END AS matched`);
}

function isExpectedStorageConflict(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes('chat_send_conflict')
    || error.message.includes('chat_regenerate_conflict')
    || error.message.includes('UNIQUE constraint failed: chat_messages.conversation_id')
    || error.message.includes('UNIQUE constraint failed: chat_messages.request_id')
  );
}

export async function acceptSend(database: D1Database, input: AcceptSendInput): Promise<ChatMutationResult> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  const userId = requireChatId(input.userId, 'user ID');
  const conversationId = requireChatId(input.conversationId, 'conversation ID');
  const operationId = requireOperationId(input.operationId);
  const expectedVersion = requireChatVersion(input.conversationVersion);
  const groupId = optionalChatId(input.groupId, 'group ID');
  const modelId = optionalChatId(input.modelId, 'model ID');
  const content = requireMessageMutationText(input.content);
  const now = requireChatTime(input.now);
  const userMessageId = input.userMessageId === undefined ? crypto.randomUUID() : requireChatId(input.userMessageId, 'user message ID');
  const assistantMessageId = input.assistantMessageId === undefined ? crypto.randomUUID() : requireChatId(input.assistantMessageId, 'assistant message ID');
  const normalized = { userId, conversationId, operationId, conversationVersion: expectedVersion, groupId, modelId, content, now,
    userMessageId, assistantMessageId };

  const owner = await requireConversationOwner(database, userId, conversationId);
  const existing = await assistantByOperation(database, userId, conversationId, operationId);
  if (existing) return replaySend(database, normalized, existing);
  if (owner.version !== expectedVersion || owner.version >= MAX_TIME) throw new ApiError('conflict');
  const nextTitle = owner.title.length === 0 ? snippet(content) : owner.title;
  try {
    const result = await batch(database, [
      prepare(database, `UPDATE chat_conversations
        SET title=?,group_id=?,model_id=?,version=version+1,updated_at=max(updated_at,?)
        WHERE id=? AND user_id=? AND version=? AND version<?
          AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE conversation_id=? AND role='assistant' AND status='generating')`,
      [nextTitle, groupId, modelId, now, conversationId, userId, expectedVersion, MAX_TIME, conversationId]),
      guard(database, 'chat_send_conflict'),
      prepare<ChatMessageRow>(database, `INSERT INTO chat_messages
        (id,conversation_id,turn_index,role,content,status,variant,selected,operation_id,request_id,group_id,model_id,created_at,updated_at)
        SELECT ?,?,COALESCE(MAX(turn_index),0)+1,'user',?,'completed',1,1,?,NULL,NULL,NULL,?,?
        FROM chat_messages WHERE conversation_id=?
        RETURNING ${messageReturningColumns}`, [userMessageId, conversationId, content, operationId, now, now, conversationId]),
      prepare<ChatMessageRow>(database, `INSERT INTO chat_messages
        (id,conversation_id,turn_index,role,content,status,variant,selected,operation_id,request_id,group_id,model_id,created_at,updated_at)
        SELECT ?,conversation_id,turn_index,'assistant','', 'generating',1,1,?,NULL,?,?,?,?
        FROM chat_messages WHERE id=? AND role='user' AND conversation_id=?
        RETURNING ${messageReturningColumns}`, [assistantMessageId, operationId, groupId, modelId, now, now, userMessageId, conversationId]),
    ] as const);
    const assistantRow = result[3].rows[0];
    const userRow = result[2].rows[0];
    if (!assistantRow || !userRow || result[0].changes !== 1) throw new ApiError('service_unavailable');
    const full = await bundle(database, userId, conversationId);
    return operationResult(full, mapMessage(assistantRow), mapMessage(userRow), false);
  } catch (error) {
    const replay = await assistantByOperation(database, userId, conversationId, operationId);
    if (replay) return replaySend(database, normalized, replay);
    if (error instanceof ApiError) throw error;
    if (isExpectedStorageConflict(error)) throw new ApiError('conflict');
    if (error instanceof Error && error.message.includes('FOREIGN KEY constraint failed')) throw new ApiError('invalid_request');
    throw new ApiError('service_unavailable', { cause: error });
  }
}

interface LatestTurn {
  readonly turnIndex: number;
  readonly userMessage: Message;
  readonly assistantCount: number;
  readonly generating: boolean;
  readonly laterRows: number;
}

async function latestTurn(database: D1Database, userId: string, conversationId: string): Promise<LatestTurn | null> {
  const row = await prepare<ChatMessageRow>(database, `
    SELECT ${messageColumns} FROM chat_messages m
    JOIN chat_conversations c ON c.id=m.conversation_id AND c.user_id=?
    WHERE m.conversation_id=? AND m.role='user'
    ORDER BY m.turn_index DESC LIMIT 1`, [userId, conversationId]).first();
  if (!row) return null;
  const userMessage = mapMessage(row);
  const state = await prepare<{ assistant_count: number; generating: number; later_rows: number }>(database, `
    SELECT
      (SELECT count(*) FROM chat_messages WHERE conversation_id=? AND role='assistant' AND turn_index=?) AS assistant_count,
      (SELECT count(*) FROM chat_messages WHERE conversation_id=? AND role='assistant' AND status='generating') AS generating,
      (SELECT count(*) FROM chat_messages WHERE conversation_id=? AND turn_index>?) AS later_rows`,
  [conversationId, userMessage.turnIndex, conversationId, conversationId, userMessage.turnIndex]).first();
  if (!state || !Number.isSafeInteger(state.assistant_count) || !Number.isSafeInteger(state.generating) || !Number.isSafeInteger(state.later_rows)) {
    throw new ApiError('service_unavailable');
  }
  return { turnIndex: userMessage.turnIndex, userMessage, assistantCount: state.assistant_count,
    generating: state.generating > 0, laterRows: state.later_rows };
}

export async function acceptRegenerate(database: D1Database, input: AcceptRegenerateInput): Promise<ChatMutationResult> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  const userId = requireChatId(input.userId, 'user ID');
  const conversationId = requireChatId(input.conversationId, 'conversation ID');
  const operationId = requireOperationId(input.operationId);
  const expectedVersion = requireChatVersion(input.conversationVersion);
  const groupId = optionalChatId(input.groupId, 'group ID');
  const modelId = optionalChatId(input.modelId, 'model ID');
  const now = requireChatTime(input.now);
  const assistantMessageId = input.assistantMessageId === undefined ? crypto.randomUUID() : requireChatId(input.assistantMessageId, 'assistant message ID');
  const normalized = { userId, conversationId, operationId, conversationVersion: expectedVersion, groupId, modelId, now, assistantMessageId };

  const owner = await requireConversationOwner(database, userId, conversationId);
  const existing = await assistantByOperation(database, userId, conversationId, operationId);
  if (existing) return replayRegenerate(database, normalized, existing);
  const turn = await latestTurn(database, userId, conversationId);
  if (!turn || turn.assistantCount < 1 || turn.laterRows !== 0 || turn.generating) throw new ApiError('conflict');
  if (owner.version !== expectedVersion || owner.version >= MAX_TIME) throw new ApiError('conflict');
  try {
    const result = await batch(database, [
      prepare(database, `UPDATE chat_conversations
        SET group_id=?,model_id=?,version=version+1,updated_at=max(updated_at,?)
        WHERE id=? AND user_id=? AND version=? AND version<?
          AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE conversation_id=? AND role='assistant' AND status='generating')`,
      [groupId, modelId, now, conversationId, userId, expectedVersion, MAX_TIME, conversationId]),
      guard(database, 'chat_regenerate_conflict'),
      prepare<ChatMessageRow>(database, `INSERT INTO chat_messages
        (id,conversation_id,turn_index,role,content,status,variant,selected,operation_id,request_id,group_id,model_id,created_at,updated_at)
        SELECT ?,u.conversation_id,u.turn_index,'assistant','', 'generating',
          COALESCE((SELECT MAX(old.variant)+1 FROM chat_messages old WHERE old.conversation_id=u.conversation_id AND old.turn_index=u.turn_index AND old.role='assistant'),1),
          CASE WHEN EXISTS(SELECT 1 FROM chat_messages old WHERE old.conversation_id=u.conversation_id AND old.turn_index=u.turn_index AND old.role='assistant' AND old.selected=1) THEN 0 ELSE 1 END,
          ?,NULL,?,?,?,?
        FROM chat_messages u
        WHERE u.id=(SELECT id FROM chat_messages WHERE conversation_id=? AND turn_index=? AND role='user')
        RETURNING ${messageReturningColumns}`,
      [assistantMessageId, operationId, groupId, modelId, now, now, conversationId, turn.turnIndex]),
    ] as const);
    const assistantRow = result[2].rows[0];
    if (!assistantRow || result[0].changes !== 1) throw new ApiError('service_unavailable');
    const full = await bundle(database, userId, conversationId);
    return operationResult(full, mapMessage(assistantRow), turn.userMessage, false);
  } catch (error) {
    const replay = await assistantByOperation(database, userId, conversationId, operationId);
    if (replay) return replayRegenerate(database, normalized, replay);
    if (error instanceof ApiError) throw error;
    if (isExpectedStorageConflict(error)) throw new ApiError('conflict');
    if (error instanceof Error && error.message.includes('FOREIGN KEY constraint failed')) throw new ApiError('invalid_request');
    throw new ApiError('service_unavailable', { cause: error });
  }
}

function normalizeAttachInput(
  inputOrUserId: AttachRequestInput | string,
  messageId?: string,
  requestId?: string,
  now?: number,
): AttachRequestInput {
  if (typeof inputOrUserId === 'string') return { userId: inputOrUserId, messageId: messageId!, requestId: requestId!, now: now! };
  return inputOrUserId;
}

export async function attachRequest(database: D1Database, input: AttachRequestInput): Promise<Message>;
export async function attachRequest(database: D1Database, userId: string, messageId: string, requestId: string, now: number): Promise<Message>;
export async function attachRequest(
  database: D1Database,
  inputOrUserId: AttachRequestInput | string,
  messageId?: string,
  requestId?: string,
  now?: number,
): Promise<Message> {
  const input = normalizeAttachInput(inputOrUserId, messageId, requestId, now);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  const userId = requireChatId(input.userId, 'user ID');
  const targetId = requireChatId(input.messageId, 'message ID');
  const request = requireChatId(input.requestId, 'request ID');
  const timestamp = requireChatTime(input.now);
  const expectedConversationId = input.conversationId === undefined ? null : requireChatId(input.conversationId, 'conversation ID');
  const expectedOperationId = input.operationId === undefined ? null : requireOperationId(input.operationId);
  if (expectedConversationId !== null || expectedOperationId !== null) {
    const candidate = await messageById(database, userId, targetId);
    if (!candidate || candidate.role !== 'assistant'
      || (expectedConversationId !== null && candidate.conversationId !== expectedConversationId)) throw new ApiError('conflict');
    if (expectedOperationId !== null) {
      const operation = await prepare<{ operation_id: string | null }>(database,
        'SELECT operation_id FROM chat_messages WHERE id=? AND role=\'assistant\'', [targetId]).first();
      if (!operation || operation.operation_id !== expectedOperationId) throw new ApiError('conflict');
    }
  }
  // 0022 is intentionally installable before 0023.  When the complete
  // schema is present, enforce the trusted web-chat source and the request's
  // immutable group/model facts; the fallback keeps local 0022-only fixtures
  // readable while still requiring request ownership.
  const requestColumns = await prepare<{ name: string }>(database, "PRAGMA table_info(requests)").all();
  const requestColumnNames = new Set(requestColumns.rows.map(row => row.name));
  const hasTrustedRequestFacts = requestColumnNames.has('source')
    && requestColumnNames.has('group_id') && requestColumnNames.has('public_model_id');
  const trustedFacts = hasTrustedRequestFacts
    ? " AND r.source='web_chat' AND r.group_id IS chat_messages.group_id AND r.public_model_id IS chat_messages.model_id"
    : '';
  try {
    const result = await prepare<ChatMessageRow>(database, `
      UPDATE chat_messages SET request_id=?,updated_at=max(updated_at,?)
      WHERE id=? AND role='assistant' AND status='generating' AND request_id IS NULL
        AND EXISTS (SELECT 1 FROM chat_conversations c JOIN requests r ON r.user_id=c.user_id
          WHERE c.id=chat_messages.conversation_id AND c.user_id=? AND r.id=? AND r.user_id=?
            ${trustedFacts})
      RETURNING ${messageReturningColumns}`, [request, timestamp, targetId, userId, request, userId]).run();
    if (result.changes === 1 && result.rows[0]) return mapMessage(result.rows[0]);
  } catch (error) {
    if (error instanceof Error && (error.message.includes('UNIQUE constraint failed: chat_messages.request_id')
      || error.message.includes('FOREIGN KEY constraint failed'))) throw new ApiError('conflict');
    throw new ApiError('service_unavailable', { cause: error });
  }
  const current = await messageById(database, userId, targetId);
  if (!current) throw new ApiError('not_found');
  if (current.requestId === request) return current;
  throw new ApiError('conflict');
}

export async function checkpoint(database: D1Database, input: CheckpointInput): Promise<Message> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  const userId = requireChatId(input.userId, 'user ID');
  const messageId = requireChatId(input.messageId, 'message ID');
  const content = requireMessageMutationText(input.content);
  const now = requireChatTime(input.now);
  const result = await prepare<ChatMessageRow>(database, `
    UPDATE chat_messages SET content=?,updated_at=max(updated_at,?)
    WHERE id=? AND role='assistant' AND status='generating'
      AND EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id=chat_messages.conversation_id AND c.user_id=?)
    RETURNING ${messageReturningColumns}`, [content, now, messageId, userId]).run();
  if (result.changes === 1 && result.rows[0]) return mapMessage(result.rows[0]);
  const current = await messageById(database, userId, messageId);
  if (!current) throw new ApiError('not_found');
  if (current.status !== 'generating') return current;
  throw new ApiError('conflict');
}

export async function finalize(database: D1Database, input: FinalizeInput): Promise<Message> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  const userId = requireChatId(input.userId, 'user ID');
  const messageId = requireChatId(input.messageId, 'message ID');
  const content = requireMessageMutationText(input.content);
  if (!['completed', 'stopped', 'failed'].includes(input.status)) invalid();
  const status = input.status;
  const now = requireChatTime(input.now);
  const current = await messageById(database, userId, messageId);
  if (!current) throw new ApiError('not_found');
  if (current.status !== 'generating') return current;
  try {
    if (status === 'failed') {
      const result = await prepare<ChatMessageRow>(database, `
        UPDATE chat_messages SET content=?,status='failed',updated_at=max(updated_at,?)
        WHERE id=? AND role='assistant' AND status='generating'
          AND EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id=chat_messages.conversation_id AND c.user_id=?)
          RETURNING ${messageReturningColumns}`, [content, now, messageId, userId]).run();
      if (result.changes === 1 && result.rows[0]) return mapMessage(result.rows[0]);
    } else {
      const result = await batch(database, [
        prepare(database, `UPDATE chat_messages SET selected=0
          WHERE conversation_id=(SELECT conversation_id FROM chat_messages WHERE id=? AND role='assistant')
            AND turn_index=(SELECT turn_index FROM chat_messages WHERE id=? AND role='assistant')
            AND role='assistant' AND selected=1 AND id<>?`, [messageId, messageId, messageId]),
        prepare<ChatMessageRow>(database, `
          UPDATE chat_messages SET content=?,status=?,selected=1,updated_at=max(updated_at,?)
          WHERE id=? AND role='assistant' AND status='generating'
            AND EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id=chat_messages.conversation_id AND c.user_id=?)
          RETURNING ${messageReturningColumns}`, [content, status, now, messageId, userId]),
        guard(database, 'chat_finalize_conflict'),
      ] as const);
      const row = result[1].rows[0];
      if (row && result[1].changes === 1) return mapMessage(row);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.message.includes('chat_finalize_conflict')) {
      const replay = await messageById(database, userId, messageId);
      if (replay && replay.status !== 'generating') return replay;
      throw new ApiError('conflict');
    }
    throw new ApiError('service_unavailable', { cause: error });
  }
  const replay = await messageById(database, userId, messageId);
  if (!replay) throw new ApiError('not_found');
  if (replay.status !== 'generating') return replay;
  throw new ApiError('conflict');
}

export async function readContext(
  database: D1Database,
  trustedUserId: string,
  conversationId: string,
  now?: number,
): Promise<readonly Message[]> {
  await requireConversationOwner(database, trustedUserId, conversationId);
  await reconcileGeneration(database, trustedUserId, conversationId, now);
  // A selected failed answer is intentionally omitted from the model context;
  // the user's input remains, and a retry/regeneration can replace the answer.
  return messagesForConversation(database, trustedUserId, conversationId, true).then(messages =>
    messages.filter(message => message.role === 'user' || message.status === 'completed' || message.status === 'stopped'));
}

async function targetForSelection(database: D1Database, userId: string, conversationId: string, messageId: string): Promise<Message> {
  const target = await messageById(database, userId, messageId);
  if (!target || target.conversationId !== conversationId) throw new ApiError('not_found');
  if (target.role !== 'assistant' || (target.status !== 'completed' && target.status !== 'stopped')) throw new ApiError('conflict');
  const turn = await latestTurn(database, userId, conversationId);
  if (!turn || turn.turnIndex !== target.turnIndex || turn.laterRows !== 0 || turn.generating) throw new ApiError('conflict');
  return target;
}

export async function selectMessageVersion(
  database: D1Database,
  input: SelectMessageVersionInput,
): Promise<SelectMessageVersionResult> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  const userId = requireChatId(input.userId, 'user ID');
  const conversationId = requireChatId(input.conversationId, 'conversation ID');
  const messageId = requireChatId(input.messageId, 'message ID');
  const expectedVersion = requireChatVersion(input.conversationVersion);
  const now = requireChatTime(input.now);
  const conversation = await requireConversationOwner(database, userId, conversationId);
  if (conversation.version !== expectedVersion || conversation.version >= MAX_TIME) throw new ApiError('conflict');
  await targetForSelection(database, userId, conversationId, messageId);
  try {
    await batch(database, [
      prepare(database, `UPDATE chat_conversations SET version=version+1,updated_at=max(updated_at,?)
        WHERE id=? AND user_id=? AND version=? AND version<?`, [now, conversationId, userId, expectedVersion, MAX_TIME]),
      guard(database, 'chat_select_conflict'),
      prepare(database, `UPDATE chat_messages SET selected=0
        WHERE conversation_id=? AND turn_index=(SELECT turn_index FROM chat_messages WHERE id=? AND role='assistant')
          AND role='assistant' AND id<>?`, [conversationId, messageId, messageId]),
      prepare(database, `UPDATE chat_messages SET selected=1
        WHERE id=? AND conversation_id=? AND role='assistant' AND status IN ('completed','stopped')`, [messageId, conversationId]),
      guard(database, 'chat_select_conflict'),
    ] as const);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.message.includes('chat_select_conflict')) throw new ApiError('conflict');
    throw new ApiError('service_unavailable', { cause: error });
  }
  const full = await bundle(database, userId, conversationId);
  return Object.freeze({ conversation: full.conversation, messages: full.messages });
}

export async function reconcileGeneration(
  database: D1Database,
  trustedUserId: string,
  conversationId?: string,
  now?: number,
): Promise<ChatGenerationRecoveryResult> {
  const userId = requireChatId(trustedUserId, 'user ID');
  const id = conversationId === undefined ? null : requireChatId(conversationId, 'conversation ID');
  const timestamp = requireChatTime(now ?? Date.now());
  const cutoff = timestamp > UNREGISTERED_GENERATION_TIMEOUT_MS ? timestamp - UNREGISTERED_GENERATION_TIMEOUT_MS : -1;
  const terminalCutoff = timestamp > TERMINAL_REQUEST_SETTLE_GRACE_MS
    ? timestamp - TERMINAL_REQUEST_SETTLE_GRACE_MS : -1;
  const result = await prepare<ChatMessageRow & { execution_status: string | null; request_finished_at: number | null; request_updated_at: number | null }>(database, `
    SELECT ${messageColumns},r.execution_status,r.finished_at AS request_finished_at,r.updated_at AS request_updated_at FROM chat_messages m
    JOIN chat_conversations c ON c.id=m.conversation_id AND c.user_id=?
    LEFT JOIN requests r ON r.id=m.request_id
    WHERE m.role='assistant' AND m.status='generating'
      AND (? IS NULL OR m.conversation_id=?)
      AND ((r.execution_status IN ('succeeded','failed','cancelled','abandoned')
        AND CASE WHEN r.finished_at IS NULL OR r.finished_at < r.updated_at THEN r.updated_at ELSE r.finished_at END <= ?)
        OR (m.request_id IS NULL AND m.created_at<=?))
    ORDER BY m.created_at ASC,m.id ASC`, [userId, id, id, terminalCutoff, cutoff]).all();
  const recovered: Message[] = [];
  for (const row of result.rows) {
    const target = mapMessage(row);
    const status: Exclude<Message['status'], 'generating'> = row.execution_status === 'cancelled' ? 'stopped'
      : row.execution_status === 'succeeded' ? 'completed' : 'failed';
    const value = await finalize(database, { userId, messageId: target.id, content: target.content, status, now: timestamp });
    if (value.status !== 'generating') recovered.push(value);
  }
  return Object.freeze({ recovered: recovered.length, messages: recovered });
}

// Names used by the stream bridge are aliases for the storage state machine.
export const finalizeMessage = finalize;
export const checkpointMessage = checkpoint;
export const selectVersion = selectMessageVersion;
export const recoverGeneratingMessages = reconcileGeneration;

// Re-export conversation CRUD from the chat storage entry point.  The service
// imports one module for its whole persistence boundary, while the actual
// implementation remains split by concern in repository.ts/messages.ts.
export { createConversationRecord as createConversation, deleteConversationRecord as deleteConversation,
  getConversationRecord as getConversation, listConversationRecords as listConversations,
  updateConversationRecord as updateConversation };

/**
 * Small positional adapter for the chat service.  Keeping this next to the
 * storage state machine lets route/service code depend on a narrow interface
 * while tests can call the atomic operations above directly.
 */
export interface ChatStorageAdapter {
  listConversations(userId: string, cursor: string | null, limit: number): Promise<{ items: readonly Conversation[]; nextCursor: string | null }>;
  getConversation(userId: string, conversationId: string): Promise<ConversationWithMessages | null>;
  createConversation(userId: string, input: { title?: string; groupId?: string | null; modelId?: string | null; now: number }): Promise<Conversation>;
  updateConversation(userId: string, conversationId: string, expectedVersion: number, patch: { title?: string; groupId?: string | null; modelId?: string | null }, now: number): Promise<Conversation>;
  deleteConversation(userId: string, conversationId: string, expectedVersion: number, now: number): Promise<boolean>;
  startMessage(userId: string, conversationId: string, input: { operationId: string; groupId: string; modelId: string; content?: string; conversationVersion: number; now: number }): Promise<
    | { kind: 'accepted'; conversation: Conversation; userMessage: Message | null; assistantMessage: Message; context: readonly { role: 'user' | 'assistant'; content: string }[] }
    | { kind: 'replayed'; conversation: Conversation; messages: readonly Message[] }
  >;
  associateRequest(userId: string, conversationId: string, assistantMessageId: string, operationId: string, requestId: string): Promise<boolean>;
  saveAssistantProgress(userId: string, conversationId: string, assistantMessageId: string, content: string, now: number): Promise<void>;
  finishAssistant(userId: string, conversationId: string, assistantMessageId: string, status: Exclude<Message['status'], 'generating'>, content: string, now: number): Promise<Message>;
  selectVersion(userId: string, conversationId: string, messageId: string, expectedConversationVersion: number, now: number): Promise<ConversationWithMessages>;
}

export function createChatStorage(database: D1Database): ChatStorageAdapter {
  return {
    listConversations: (userId, cursor, limit) => listConversationRecords(database, userId, { cursor, limit }),
    getConversation: (userId, conversationId) => getConversationWithMessages(database, userId, conversationId),
    createConversation: (userId, input) => createConversationRecord(database, userId, input),
    updateConversation: (userId, conversationId, expectedVersion, patch, now) => updateConversationRecord(database, userId, conversationId, expectedVersion, patch, now),
    deleteConversation: (userId, conversationId, expectedVersion, _now) => deleteConversationRecord(database, userId, conversationId, expectedVersion),
    startMessage: async (userId, conversationId, input) => {
      if (input.content === undefined) {
        const accepted = await acceptRegenerate(database, { userId, conversationId, operationId: input.operationId,
          conversationVersion: input.conversationVersion, groupId: input.groupId, modelId: input.modelId, now: input.now });
        if (accepted.replayed) return { kind: 'replayed', conversation: accepted.conversation, messages: accepted.messages };
        return { kind: 'accepted', conversation: accepted.conversation, userMessage: accepted.userMessage,
          assistantMessage: accepted.assistantMessage, context: (await readContext(database, userId, conversationId, input.now)).map(message => ({ role: message.role, content: message.content })) };
      }
      const accepted = await acceptSend(database, { userId, conversationId, operationId: input.operationId,
        conversationVersion: input.conversationVersion, groupId: input.groupId, modelId: input.modelId, content: input.content, now: input.now });
      if (accepted.replayed) return { kind: 'replayed', conversation: accepted.conversation, messages: accepted.messages };
      return { kind: 'accepted', conversation: accepted.conversation, userMessage: accepted.userMessage,
        assistantMessage: accepted.assistantMessage, context: (await readContext(database, userId, conversationId, input.now)).map(message => ({ role: message.role, content: message.content })) };
    },
    associateRequest: async (userId, conversationId, assistantMessageId, operationId, requestId) => {
      try {
        const current = await messageById(database, userId, assistantMessageId);
        if (!current || current.conversationId !== conversationId || current.role !== 'assistant') return false;
        const operation = await prepare<{ operation_id: string | null }>(database,
          'SELECT operation_id FROM chat_messages WHERE id=? AND conversation_id=? AND role=\'assistant\'', [assistantMessageId, conversationId]).first();
        if (!operation || operation.operation_id !== operationId) return false;
        await attachRequest(database, { userId, messageId: assistantMessageId, requestId, now: current.updatedAt,
          conversationId, operationId });
        return true;
      } catch { return false; }
    },
    saveAssistantProgress: async (userId, conversationId, assistantMessageId, content, now) => {
      const current = await messageById(database, userId, assistantMessageId);
      if (!current || current.conversationId !== conversationId) throw new ApiError('not_found');
      await checkpoint(database, { userId, messageId: assistantMessageId, content, now });
    },
    finishAssistant: async (userId, conversationId, assistantMessageId, status, content, now) => {
      const current = await messageById(database, userId, assistantMessageId);
      if (!current || current.conversationId !== conversationId) throw new ApiError('not_found');
      return finalize(database, { userId, messageId: assistantMessageId, status, content, now });
    },
    selectVersion: (userId, conversationId, messageId, expectedConversationVersion, now) =>
      selectMessageVersion(database, { userId, conversationId, messageId, conversationVersion: expectedConversationVersion, now }),
  };
}
