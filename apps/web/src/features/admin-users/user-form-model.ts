import { z } from 'zod';
import type { UserListItem } from '@cheapai/api-client/users';
import { userInputSchema, userPatchSchema } from '@cheapai/contracts/users';

export const unlimitedUserLimit = Number.MAX_SAFE_INTEGER;

const safeLimitText = z
  .string()
  .trim()
  .regex(/^(?:|[1-9][0-9]*)$/u, '请输入正整数，或留空表示不限。')
  .refine((value) => value === '' || Number.isSafeInteger(Number(value)), '数值超出安全整数范围。')
  .transform((value) => (value === '' ? unlimitedUserLimit : Number(value)));

const createFormSchema = z.object({
  mode: z.literal('create'),
  email: userInputSchema.shape.email
    .trim()
    .email('请输入有效邮箱。')
    .max(254, '邮箱不能超过 254 个字符。'),
  password: userInputSchema.shape.password
    .min(6, '初始密码至少需要 6 个字符。')
    .max(128, '密码不能超过 128 个字符。'),
  groupId: userInputSchema.shape.groupId.unwrap(),
});

const editFormSchema = z.object({
  mode: z.literal('edit'),
  status: userPatchSchema.shape.status,
  groupId: userPatchSchema.shape.groupId,
  concurrencyLimit: safeLimitText.pipe(userPatchSchema.shape.concurrencyLimit),
  rpmLimit: safeLimitText.pipe(userPatchSchema.shape.rpmLimit),
  allowedGroupIds: userPatchSchema.shape.allowedGroupIds.unwrap(),
});

export const userFormSchema = z.discriminatedUnion('mode', [createFormSchema, editFormSchema]);
export type UserFormValues = z.input<typeof userFormSchema>;
export type ParsedUserFormValues = z.output<typeof userFormSchema>;

export type UserFormInitialState =
  | { readonly mode: 'create'; readonly user?: never }
  | { readonly mode: 'edit'; readonly user: UserListItem };

export function initialUserFormValues(props: UserFormInitialState): UserFormValues {
  if (props.mode === 'create') return { mode: 'create', email: '', password: '', groupId: '' };
  return {
    mode: 'edit',
    status: props.user.status,
    groupId: props.user.group_id,
    concurrencyLimit:
      props.user.concurrency_limit === unlimitedUserLimit
        ? ''
        : String(props.user.concurrency_limit),
    rpmLimit: props.user.rpm_limit === unlimitedUserLimit ? '' : String(props.user.rpm_limit),
    allowedGroupIds: [...props.user.allowed_group_ids],
  };
}
