import { pageSchema } from './common.js';
import { sellPricesSchema } from './models.js';
import { z } from 'zod';

const textSchema = (max = 128) => z.string().min(1).max(max);
const timestampSchema = z.number().int().nonnegative().refine(Number.isSafeInteger);

export const keyStateSchema = z.enum(['all', 'active', 'expired', 'revoked']);

export const keyInputSchema = z.object({
  name: z.string(),
  expiresAt: timestampSchema.nullable(),
  groupId: z.string(),
});

export const keyGroupSchema = z.object({
  id: textSchema(),
  name: textSchema(),
  models: z.array(textSchema()),
  /** Optional for compatibility with older cached account-group responses. */
  billingMultiplier: z
    .string()
    .max(64)
    .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u)
    .optional(),
  /** Base USD-per-million-token prices, keyed by public model ID. */
  modelPrices: z.record(z.string(), sellPricesSchema).optional(),
});

export const keyMetadataSchema = z
  .object({
    id: textSchema(),
    userId: textSchema(),
    groupId: textSchema(),
    groupName: textSchema(),
    name: textSchema(),
    displayPrefix: z.string().regex(/^s2a_key_[A-Za-z0-9_-]{8}$/u),
    status: z.enum(['active', 'revoked']),
    allowedModels: z.array(textSchema()).nullable(),
    expiresAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    version: timestampSchema.min(1),
  })
  .superRefine((value, context) => {
    if (value.updatedAt < value.createdAt) {
      context.addIssue({
        code: 'custom',
        message: 'Key update time precedes creation time.',
        path: ['updatedAt'],
      });
    }
    if (
      value.allowedModels !== null &&
      new Set(value.allowedModels).size !== value.allowedModels.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Key model list contains duplicates.',
        path: ['allowedModels'],
      });
    }
  });

export const keysPageSchema = pageSchema(keyMetadataSchema);

const createdKeySchema = z.object({
  kind: z.literal('created'),
  key: keyMetadataSchema,
  token: z.string().regex(/^s2a_key_[A-Za-z0-9_-]{43}$/u),
});

const replayedKeySchema = z.object({
  kind: z.literal('replayed'),
  key: keyMetadataSchema,
});

export const keyCreationSchema = z.union([createdKeySchema, replayedKeySchema]);

export const keyRevocationResultSchema = z.object({
  kind: z.enum(['revoked', 'already_revoked']),
  key: keyMetadataSchema,
});

type KeyMetadataShape = z.infer<typeof keyMetadataSchema>;
type KeyGroupShape = z.infer<typeof keyGroupSchema>;
export type KeyMetadata = Readonly<Omit<KeyMetadataShape, 'allowedModels'>> & {
  readonly allowedModels: readonly string[] | null;
};
export type KeyInput = Readonly<z.infer<typeof keyInputSchema>>;
export type KeyGroup = Readonly<Omit<KeyGroupShape, 'models'>> & {
  readonly models: readonly string[];
};
export type KeyCreation = Readonly<z.infer<typeof keyCreationSchema>> & {
  readonly key: KeyMetadata;
};
export type KeyRevocationResult = Readonly<z.infer<typeof keyRevocationResultSchema>> & {
  readonly key: KeyMetadata;
};
export type KeyState = z.infer<typeof keyStateSchema>;

export function decodeKeyMetadata(value: unknown): KeyMetadata {
  return keyMetadataSchema.parse(value) as KeyMetadata;
}

export function decodeKeyGroup(value: unknown): KeyGroup {
  return keyGroupSchema.parse(value) as KeyGroup;
}

export function decodeKeyGroups(value: unknown): readonly KeyGroup[] {
  const groups = z.object({ items: z.array(keyGroupSchema) }).parse(value).items;
  return groups as readonly KeyGroup[];
}

export function decodeKeysPage(value: unknown): {
  readonly items: readonly KeyMetadata[];
  readonly nextCursor: string | null;
} {
  const page = keysPageSchema.parse(value);
  return { items: page.items as readonly KeyMetadata[], nextCursor: page.nextCursor };
}

export function decodeKeyCreation(value: unknown): KeyCreation {
  return keyCreationSchema.parse(value) as KeyCreation;
}

export function decodeKeyRevocationResult(value: unknown): KeyRevocationResult {
  return keyRevocationResultSchema.parse(value) as KeyRevocationResult;
}
