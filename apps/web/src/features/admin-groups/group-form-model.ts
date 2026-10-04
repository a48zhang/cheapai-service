import { z } from 'zod';
import type { GroupPatch, GroupView } from '@cheapai/api-client/groups';
import { groupInputSchema } from '@cheapai/contracts/groups';

/** UI-shaped values pipe through the public field schemas for validation and normalization. */
export const groupDraftSchema = z
  .object({
    name: z.string().pipe(groupInputSchema.shape.name),
    status: z.string().pipe(groupInputSchema.shape.status.unwrap()),
    billingMultiplier: z.string().pipe(groupInputSchema.shape.billingMultiplier.unwrap()),
    channelIds: z.array(z.string()).pipe(groupInputSchema.shape.channelIds.unwrap()),
  })
  .strict();

export type GroupFormValues = z.input<typeof groupDraftSchema>;
export type GroupFormOutput = z.output<typeof groupDraftSchema>;

export function initialGroupFormValues(group?: GroupView): GroupFormValues {
  return {
    name: group?.name ?? '',
    status: group?.status ?? 'active',
    billingMultiplier: group?.billingMultiplier ?? '1',
    channelIds: group ? [...group.channelIds] : [],
  };
}

/** Compare channel IDs independent of server ordering, sorting each input once. */
export function channelIdsMatch(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

export function createGroupPatch(baseline: GroupView, values: GroupFormOutput): GroupPatch | null {
  const patch: GroupPatch = {
    ...(baseline.name === values.name ? {} : { name: values.name }),
    ...(baseline.status === values.status ? {} : { status: values.status }),
    ...(channelIdsMatch(baseline.channelIds, values.channelIds)
      ? {}
      : { channelIds: values.channelIds }),
    ...(baseline.billingMultiplier === values.billingMultiplier
      ? {}
      : { billingMultiplier: values.billingMultiplier }),
  };
  return Object.keys(patch).length === 0 ? null : patch;
}
