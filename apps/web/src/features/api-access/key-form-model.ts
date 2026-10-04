import { z } from 'zod';
import type { KeyMetadata } from '@cheapai/api-client/keys';
import { formatLocalDateTime, parseLocalDateTime } from '../../shared/lib/datetime';

export const keyFormSchema = z.object({
  name: z.string().trim().min(1, '请输入 Key 名称。').max(128, '名称不能超过 128 个字符。'),
  groupId: z.string().min(1, '请选择管理员开放的分组。'),
  expiresAt: z.string(),
});

export type KeyFormValues = z.infer<typeof keyFormSchema>;

export function keyExpiryText(timestamp: number | null): string {
  return formatLocalDateTime(timestamp);
}

export function initialKeyFormValues(key: KeyMetadata | null = null): KeyFormValues {
  return {
    name: key?.name ?? '',
    groupId: key?.groupId ?? '',
    expiresAt: keyExpiryText(key?.expiresAt ?? null),
  };
}

/** Empty input means no expiry. Undefined marks invalid/noncanonical local input. */
export function parseKeyExpiry(value: string): number | null | undefined {
  if (value === '') return null;
  return parseLocalDateTime(value);
}

/** Keep the original server timestamp when the minute-resolution field is unchanged. */
export function editedKeyExpiry(
  value: string,
  currentTimestamp: number | null,
  initialText: string,
): number | null | undefined {
  return value === initialText ? currentTimestamp : parseKeyExpiry(value);
}
