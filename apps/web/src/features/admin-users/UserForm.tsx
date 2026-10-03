import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useInfiniteQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { PublicUser } from '@cheapai/contracts/auth';
import type { UserListItem, UserPatch } from '@cheapai/api-client/users';
import type { AdminUsersApi } from './api';
import { flattenUserGroups, userGroupsQueryOptions } from './api';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Select } from '../../shared/ui/Select';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

const safeLimitText = z.string().trim()
  .regex(/^(?:|[1-9][0-9]*)$/u, '请输入正整数，或留空表示不限。')
  .refine(value => value === '' || Number.isSafeInteger(Number(value)), '数值超出安全整数范围。')
  .transform(value => value === '' ? Number.MAX_SAFE_INTEGER : Number(value));

const createFormSchema = z.object({
  mode: z.literal('create'),
  email: z.string().trim().email('请输入有效邮箱。').max(254, '邮箱不能超过 254 个字符。'),
  password: z.string().min(6, '初始密码至少需要 6 个字符。').max(128, '密码不能超过 128 个字符。'),
  groupId: z.string(),
});

const editFormSchema = z.object({
  mode: z.literal('edit'),
  status: z.enum(['active', 'disabled']),
  groupId: z.string().min(1, '请选择默认分组。'),
  concurrencyLimit: safeLimitText,
  rpmLimit: safeLimitText,
  allowedGroupIds: z.array(z.string().min(1)),
});

const userFormSchema = z.discriminatedUnion('mode', [createFormSchema, editFormSchema]);
type UserFormValues = z.input<typeof userFormSchema>;
type ParsedUserFormValues = z.output<typeof userFormSchema>;

type CommonProps = {
  readonly open: boolean;
  readonly api: AdminUsersApi;
  readonly actorId: string;
  readonly epoch: number;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: (user: PublicUser) => void;
};

export type UserFormProps = CommonProps & (
  | { readonly mode: 'create'; readonly user?: never }
  | { readonly mode: 'edit'; readonly user: UserListItem }
);

function initialValues(props: UserFormProps): UserFormValues {
  if (props.mode === 'create') return { mode: 'create', email: '', password: '', groupId: '' };
  return {
    mode: 'edit',
    status: props.user.status,
    groupId: props.user.group_id,
    concurrencyLimit: props.user.concurrency_limit === Number.MAX_SAFE_INTEGER ? '' : String(props.user.concurrency_limit),
    rpmLimit: props.user.rpm_limit === Number.MAX_SAFE_INTEGER ? '' : String(props.user.rpm_limit),
    allowedGroupIds: [...props.user.allowed_group_ids],
  };
}

function isDefinitiveClientRejection(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && error.status !== null && error.status >= 400 && error.status < 500;
}

/** Create accounts or edit their supported access settings against the loaded version. */
export function UserForm(props: UserFormProps) {
  const { open, mode, api, actorId, epoch, onOpenChange, onSaved } = props;
  const user = mode === 'edit' ? props.user : null;
  const groupsQuery = useInfiniteQuery({ ...userGroupsQueryOptions(api, actorId, epoch), enabled: open });
  const groups = useMemo(() => flattenUserGroups(groupsQuery.data?.pages), [groupsQuery.data]);
  const [saving, setSaving] = useState(false);
  const [locked, setLocked] = useState(false);
  const [message, setMessage] = useState<Error | null>(null);
  const saveRef = useRef(false);
  const form = useForm<UserFormValues, unknown, ParsedUserFormValues>({
    resolver: zodResolver(userFormSchema),
    defaultValues: initialValues(props),
  });

  useLayoutEffect(() => {
    if (!open) return;
    form.reset(initialValues(props));
    setLocked(false);
    setMessage(null);
  // The form is intentionally reset when the dialog opens for a new user/version.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, actorId, epoch, user?.id, user?.version]);

  const close = (nextOpen: boolean) => {
    if (saveRef.current) return;
    onOpenChange(nextOpen);
  };

  const submit = form.handleSubmit(async (values: ParsedUserFormValues) => {
    if (saveRef.current || locked || values.mode !== mode) return;
    saveRef.current = true;
    setSaving(true);
    setMessage(null);
    try {
      if (values.mode === 'create') {
        const created = await api.create({
          email: values.email,
          password: values.password,
          ...(values.groupId ? { groupId: values.groupId } : {}),
        });
        onSaved(created);
        setMessage(new Error(`用户 ${created.email_normalized} 已创建。`));
        return;
      }
      if (!user) return;
      if (values.groupId !== user.group_id && !groups.some(group => group.id === values.groupId && group.status === 'active')) {
        setMessage(new Error('请选择已加载的有效分组；如尚未找到，请继续加载分组。'));
        return;
      }
      if (user.group_status === 'disabled' && values.groupId !== user.group_id) {
        setMessage(new Error('当前默认分组已停用。请先从有效分组中选择新的默认分组。'));
        return;
      }
      const patch: UserPatch = {
        status: values.status,
        groupId: values.groupId,
        concurrencyLimit: values.concurrencyLimit,
        rpmLimit: values.rpmLimit,
        // Keep grants whose groups are inactive or have not appeared in the loaded candidate pages.
        allowedGroupIds: [...new Set([...values.allowedGroupIds, values.groupId])],
      };
      const updated = await api.update(user.id, user.version, patch);
      onSaved(updated);
      setMessage(new Error('用户设置已保存。'));
      setLocked(true);
    } catch (error) {
      if (mode === 'create' && isDefinitiveClientRejection(error)) {
        setMessage(error);
      } else {
        setLocked(true);
        setMessage(new Error(mode === 'edit'
          ? error instanceof ApiClientError && error.status === 409
            ? '用户版本已变化，或触发最后管理员保护。请关闭后重新读取，再核对当前设置。'
            : '保存结果暂时无法确认。请关闭后重新读取用户状态；不会自动重试。'
          : '创建结果尚未确认，账户可能已经创建。请返回列表核对；本表单不会重复提交。'));
      }
    } finally {
      saveRef.current = false;
      setSaving(false);
      if (mode === 'create') form.setValue('password', '');
    }
  });

  const currentGroupOption = mode === 'edit' && user
    ? [{ value: user.group_id, label: `${user.group_name}（当前）` }]
    : [];
  const groupItems = mode === 'create'
    ? groups.filter(group => group.status === 'active').map(group => ({ value: group.id, label: group.name }))
    : [...currentGroupOption, ...groups.filter(group => group.status === 'active' && group.id !== user?.group_id)
      .map(group => ({ value: group.id, label: group.name }))];
  return <Dialog
    open={open}
    onOpenChange={close}
    title={mode === 'create' ? '创建普通用户' : `编辑用户 · ${user?.email_normalized ?? ''}`}
    description={mode === 'create'
      ? '初始角色与密码策略由服务端确定；不支持通过此表单更改角色。'
      : '角色只读。状态、默认分组、授权分组与限额使用当前用户版本保存。'}
    closeLabel="关闭用户表单"
    closeButton={!saving}
    footer={<>
      <Button variant="secondary" disabled={saving} onClick={() => close(false)}>关闭</Button>
      <Button type="submit" form="admin-user-form" busy={saving} disabled={locked || groupsQuery.isFetchingNextPage || (mode === 'edit' && groupsQuery.isError)}>
        {mode === 'create' ? '创建用户' : '保存用户设置'}
      </Button>
    </>}
  >
    <form id="admin-user-form" noValidate className="space-y-5" onSubmit={submit}>
      {message && <div role="status" className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{message.message}</div>}
      {mode === 'create' ? <>
        <Field label="邮箱" required error={form.getFieldState('email').error?.message}>
          <Input {...form.register('email')} type="email" required autoComplete="off" maxLength={254} />
        </Field>
        <Field label="初始密码" required error={form.getFieldState('password').error?.message} description="密码只发送给服务端，本页提交后会清除输入。">
          <Input {...form.register('password')} type="password" required autoComplete="new-password" minLength={6} maxLength={128} />
        </Field>
        <Controller name="groupId" control={form.control} render={({ field, fieldState }) => <Field
          label="初始分组"
          error={fieldState.error?.message}
          description="留空时由服务端分配默认分组。"
        >
          <Select
            value={field.value}
            onValueChange={field.onChange}
            placeholder="服务器默认分组"
            items={groupItems}
            disabled={groupsQuery.isPending || groupsQuery.isError}
          />
        </Field>} />
      </> : user && <>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-sm">
          <p className="font-medium">{user.email_normalized}</p>
          <p className="mt-1 text-[var(--muted)]">角色：{user.role === 'admin' ? '管理员' : '普通用户'}（只读）</p>
          <p className="mt-1 text-xs text-[var(--muted)]">版本 {user.version}</p>
        </div>
        <Field label="账户状态" required error={form.getFieldState('status').error?.message}>
          <select {...form.register('status')} className="min-h-10 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm">
            <option value="active">启用</option>
            <option value="disabled">停用</option>
          </select>
        </Field>
        <Controller name="groupId" control={form.control} render={({ field, fieldState }) => <Field
          label="默认分组"
          required
          error={fieldState.error?.message}
          description="切换默认分组会将新默认分组加入授权列表。"
        >
          <Select
            value={field.value}
            onValueChange={value => {
              field.onChange(value);
              const allowed = form.getValues('allowedGroupIds');
              if (!allowed.includes(value)) form.setValue('allowedGroupIds', [...allowed, value], { shouldDirty: true });
            }}
            items={groupItems}
            disabled={groupsQuery.isPending || groupsQuery.isError}
          />
        </Field>} />
        {groupsQuery.isError && <ApiErrorNotice error={groupsQuery.error} onRetry={() => { void groupsQuery.refetch(); }} />}
        <Controller name="allowedGroupIds" control={form.control} render={({ field }) => {
          const visible = groups.filter(group => group.status === 'active');
          const hidden = field.value.filter(id => !visible.some(group => group.id === id));
          return <fieldset className="space-y-3 rounded-lg border border-[var(--border)] p-4" disabled={saving || locked}>
            <legend className="px-1 text-sm font-medium">可访问分组</legend>
            <p className="text-xs text-[var(--muted)]">默认分组必须保留。尚未加载或已停用的既有授权会保留，避免无意撤销。</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {visible.map(group => <label key={group.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={field.value.includes(group.id)}
                  disabled={group.id === form.getValues('groupId')}
                  onChange={event => field.onChange(event.currentTarget.checked
                    ? [...new Set([...field.value, group.id])]
                    : field.value.filter(id => id !== group.id))}
                />
                <span>{group.name}</span>
              </label>)}
            </div>
            {hidden.length > 0 && <p className="break-all text-xs text-[var(--muted)]">保留未显示授权：{hidden.join('、')}</p>}
            {groupsQuery.hasNextPage && <Button type="button" size="sm" variant="secondary" busy={groupsQuery.isFetchingNextPage} onClick={() => { void groupsQuery.fetchNextPage(); }}>加载更多分组</Button>}
          </fieldset>;
        }} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="并发请求上限" error={form.getFieldState('concurrencyLimit').error?.message} description="留空表示不限。">
            <Input {...form.register('concurrencyLimit')} inputMode="numeric" maxLength={16} />
          </Field>
          <Field label="每分钟请求上限" error={form.getFieldState('rpmLimit').error?.message} description="留空表示不限。">
            <Input {...form.register('rpmLimit')} inputMode="numeric" maxLength={16} />
          </Field>
        </div>
      </>}
      {mode === 'create' && groupsQuery.isError && <ApiErrorNotice error={groupsQuery.error} onRetry={() => { void groupsQuery.refetch(); }} />}
      {mode === 'create' && groupsQuery.hasNextPage && <Button type="button" variant="secondary" busy={groupsQuery.isFetchingNextPage} onClick={() => { void groupsQuery.fetchNextPage(); }}>加载更多分组</Button>}
      {mode === 'create' && groupsQuery.isPending && <p role="status" className="text-xs text-[var(--muted)]">正在读取可选分组；也可使用服务器默认分组。</p>}
    </form>
  </Dialog>;
}
