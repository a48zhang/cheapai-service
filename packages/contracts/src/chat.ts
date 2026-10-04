import { z } from 'zod';
import { sellPricesSchema } from './models.js';

const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const textSchema = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim() === value);
const nonEmptyTextSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value);
const contentSchema = z.string().max(1_000_000);
const nullableTextSchema = (max: number) => nonEmptyTextSchema(max).nullable();

export const chatRoleSchema = z.enum(['user', 'assistant']);
export const chatMessageStatusSchema = z.enum(['generating', 'completed', 'stopped', 'failed']);

export const chatModelSchema = z.object({
  publicModelId: nonEmptyTextSchema(256),
  maxOutputTokens: positiveSchema.optional(),
  /** Price snapshot is display-only; missing values remain unavailable, never free. */
  sellPrices: sellPricesSchema.optional(),
});

export const chatGroupSchema = z.object({
  id: nonEmptyTextSchema(128),
  name: nonEmptyTextSchema(256),
  billingMultiplier: textSchema(128).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u),
  models: z.array(chatModelSchema),
});

export const chatModelsSchema = z.object({
  items: z.array(chatGroupSchema),
});

export const conversationSchema = z
  .object({
    id: nonEmptyTextSchema(128),
    title: textSchema(512),
    groupId: nullableTextSchema(128),
    modelId: nullableTextSchema(256),
    version: positiveSchema,
    createdAt: countSchema,
    updatedAt: countSchema,
  })
  .refine((value) => value.updatedAt >= value.createdAt, { path: ['updatedAt'] });

export const chatMessageSchema = z
  .object({
    id: nonEmptyTextSchema(128),
    conversationId: nonEmptyTextSchema(128),
    turnIndex: countSchema,
    role: chatRoleSchema,
    content: contentSchema,
    status: chatMessageStatusSchema,
    variant: positiveSchema,
    selected: z.boolean(),
    requestId: nullableTextSchema(256),
    groupId: nullableTextSchema(128),
    modelId: nullableTextSchema(256),
    createdAt: countSchema,
    updatedAt: countSchema,
  })
  .refine((value) => value.updatedAt >= value.createdAt, { path: ['updatedAt'] })
  .refine((value) => value.role !== 'user' || value.content.trim().length > 0, {
    path: ['content'],
  });

export const conversationDetailSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(chatMessageSchema),
});

const chatCursorSchema = z
  .string()
  .max(2048)
  .refine((value) => value.trim() === value)
  .nullable();
export const conversationPageSchema = z.object({
  items: z.array(conversationSchema),
  nextCursor: chatCursorSchema,
});

export const conversationCreateInputSchema = z.object({
  title: textSchema(512).optional(),
  groupId: nullableTextSchema(128).optional(),
  modelId: nullableTextSchema(256).optional(),
});

export const conversationPatchInputSchema = z.object({
  version: positiveSchema,
  title: textSchema(512).optional(),
  groupId: nullableTextSchema(128).optional(),
  modelId: nullableTextSchema(256).optional(),
});

const operationIdSchema = nonEmptyTextSchema(128);

export const chatSendInputSchema = z.object({
  operationId: operationIdSchema,
  conversationVersion: positiveSchema,
  groupId: nonEmptyTextSchema(128),
  modelId: nonEmptyTextSchema(256),
  content: contentSchema.refine((value) => value.trim().length > 0),
  maxOutputTokens: positiveSchema.optional(),
});

export const chatRegenerateInputSchema = z.object({
  operationId: operationIdSchema,
  conversationVersion: positiveSchema,
  groupId: nonEmptyTextSchema(128),
  modelId: nonEmptyTextSchema(256),
  maxOutputTokens: positiveSchema.optional(),
});

export const chatSelectInputSchema = z.object({
  conversationVersion: positiveSchema,
  messageId: nonEmptyTextSchema(128),
});

export const chatMetaEventSchema = z.object({
  conversation: conversationSchema,
  userMessage: chatMessageSchema.nullable(),
  assistantMessage: chatMessageSchema,
});

export const chatErrorEventSchema = z.object({
  code: nonEmptyTextSchema(128),
  message: nonEmptyTextSchema(4_096),
  messageId: nonEmptyTextSchema(128).optional(),
});

export const chatDeltaEventSchema = z.object({
  text: contentSchema,
});

export const chatDoneEventSchema = z.object({
  message: chatMessageSchema,
  billingStatus: textSchema(128).optional(),
});

export const chatSseEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('meta'), data: chatMetaEventSchema }),
  z.object({ event: z.literal('delta'), data: chatDeltaEventSchema }),
  z.object({ event: z.literal('done'), data: chatDoneEventSchema }),
  z.object({ event: z.literal('error'), data: chatErrorEventSchema }),
]);

export const chatStreamResultSchema = z.object({
  kind: z.literal('stream'),
  message: chatMessageSchema,
  billingStatus: textSchema(128).optional(),
});

export const chatReplayWireSchema = conversationDetailSchema.extend({
  replayed: z.literal(true),
});

/** Adds the client-only discriminator after validating the Worker wire envelope. */
export const chatReplayResultSchema = chatReplayWireSchema.transform((value) => ({
  kind: 'replay' as const,
  ...value,
}));

export type ChatRole = z.infer<typeof chatRoleSchema>;
export type ChatMessageStatus = z.infer<typeof chatMessageStatusSchema>;
export type ChatModel = z.infer<typeof chatModelSchema>;
export type ChatGroup = z.infer<typeof chatGroupSchema>;
export type ChatModels = z.infer<typeof chatModelsSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ConversationDetail = z.infer<typeof conversationDetailSchema>;
export type ConversationPage = z.infer<typeof conversationPageSchema>;
export type ChatList = ConversationPage;
export type ConversationCreateInput = z.infer<typeof conversationCreateInputSchema>;
export type ConversationPatchInput = z.infer<typeof conversationPatchInputSchema>;
export type ChatSendInput = z.infer<typeof chatSendInputSchema>;
export type ChatRegenerateInput = z.infer<typeof chatRegenerateInputSchema>;
export type ChatSelectInput = z.infer<typeof chatSelectInputSchema>;
export type ChatMetaEvent = z.infer<typeof chatMetaEventSchema>;
export type ChatErrorEvent = z.infer<typeof chatErrorEventSchema>;
export type ChatDeltaEvent = z.infer<typeof chatDeltaEventSchema>;
export type ChatDoneEvent = z.infer<typeof chatDoneEventSchema>;
export type ChatSseEvent = z.infer<typeof chatSseEventSchema>;
export type ChatStreamResult = z.infer<typeof chatStreamResultSchema>;
export type ChatReplayResult = z.infer<typeof chatReplayResultSchema>;
export type ChatSendResult = ChatStreamResult | ChatReplayResult;

export interface ChatStreamHandlers {
  readonly onMeta?: (value: ChatMetaEvent) => void | Promise<void>;
  readonly onDelta?: (text: string) => void | Promise<void>;
  readonly onDone?: (value: ChatMessage, billingStatus?: string) => void | Promise<void>;
  readonly onError?: (value: ChatErrorEvent) => void | Promise<void>;
}

function decode<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TypeError(message);
  return result.data;
}

export function decodeChatModels(value: unknown): ChatModels {
  return decode(chatModelsSchema, value, '聊天响应数据结构无效。');
}

export function decodeConversation(value: unknown): Conversation {
  return decode(conversationSchema, value, '聊天响应数据结构无效。');
}

export function decodeChatMessage(value: unknown): ChatMessage {
  return decode(chatMessageSchema, value, '聊天响应数据结构无效。');
}

export function decodeConversationDetail(value: unknown): ConversationDetail {
  return decode(conversationDetailSchema, value, '聊天响应数据结构无效。');
}

export function decodeConversationPage(value: unknown): ConversationPage {
  return decode(conversationPageSchema, value, '聊天响应数据结构无效。');
}

export function decodeDeleted(value: unknown): { readonly deleted: true } {
  return decode(z.object({ deleted: z.literal(true) }), value, '聊天响应数据结构无效。');
}

export function decodeChatReplay(value: unknown): ChatReplayResult {
  return decode(chatReplayResultSchema, value, '聊天响应数据结构无效。');
}
