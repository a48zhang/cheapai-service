import { Controller } from 'react-hook-form';
import type { UserFormProps as Props } from './useUserForm';
import { useUserForm } from './useUserForm';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Select } from '../../shared/ui/Select';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

export type { UserFormProps } from './useUserForm';

/** Create accounts or edit their supported access settings against the loaded version. */
export function UserForm(props: Props) {
  const { open, mode } = props;
  const user = mode === 'edit' ? props.user : null;
  const { form, groupsQuery, groups, saving, locked, message, close, submit } = useUserForm(props);

  const currentGroupOption =
    mode === 'edit' && user ? [{ value: user.group_id, label: `${user.group_name}（当前）` }] : [];
  const groupItems =
    mode === 'create'
      ? groups
          .filter((group) => group.status === 'active')
          .map((group) => ({ value: group.id, label: group.name }))
      : [
          ...currentGroupOption,
          ...groups
            .filter((group) => group.status === 'active' && group.id !== user?.group_id)
            .map((group) => ({ value: group.id, label: group.name })),
        ];

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={mode === 'create' ? '创建普通用户' : `编辑用户 · ${user?.email_normalized ?? ''}`}

      closeLabel="关闭用户表单"
      closeButton={!saving}
      footer={
        <>
          <Button variant="secondary" disabled={saving} onClick={() => close(false)}>
            关闭
          </Button>
          <Button
            type="submit"
            form="admin-user-form"
            busy={saving}
            disabled={
              locked || groupsQuery.isFetchingNextPage || (mode === 'edit' && groupsQuery.isError)
            }
          >
            {mode === 'create' ? '创建用户' : '保存用户设置'}
          </Button>
        </>
      }
    >
      <form id="admin-user-form" noValidate className="space-y-5" onSubmit={submit}>
        {message &&
          (typeof message === 'string' ? (
            <div
              role="status"
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-subtle)] p-3 text-sm text-[var(--color-ink-secondary)]"
            >
              {message}
            </div>
          ) : (
            <ApiErrorNotice error={message} />
          ))}
        {mode === 'create' ? (
          <>
            <Field label="邮箱" required error={form.getFieldState('email').error?.message}>
              <Input
                {...form.register('email')}
                type="email"
                required
                autoComplete="off"
                maxLength={254}
              />
            </Field>
            <Field label="初始密码" required error={form.getFieldState('password').error?.message}>
              <Input
                {...form.register('password')}
                type="password"
                required
                autoComplete="new-password"
                minLength={6}
                maxLength={128}
              />
            </Field>
            <Controller
              name="groupId"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field
                  label="初始分组"
                  error={fieldState.error?.message}
                  description="留空使用默认分组。"
                >
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    placeholder="服务器默认分组"
                    items={groupItems}
                    disabled={groupsQuery.isPending || groupsQuery.isError}
                  />
                </Field>
              )}
            />
          </>
        ) : (
          user && (
            <>
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-4 text-sm">
                <p className="font-medium">{user.email_normalized}</p>
                <p className="mt-1 text-[var(--color-muted-foreground)]">
                  角色：{user.role === 'admin' ? '管理员' : '普通用户'}（只读）
                </p>
                <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                  版本 {user.version}
                </p>
              </div>
              <Field label="账户状态" required error={form.getFieldState('status').error?.message}>
                <select
                  {...form.register('status')}
                  className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
                >
                  <option value="active">启用</option>
                  <option value="disabled">停用</option>
                </select>
              </Field>
              <Controller
                name="groupId"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field
                    label="默认分组"
                    required
                    error={fieldState.error?.message}
                    description="切换默认分组会将新默认分组加入授权列表。"
                  >
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        const allowed = form.getValues('allowedGroupIds');
                        if (!allowed.includes(value))
                          form.setValue('allowedGroupIds', [...allowed, value], {
                            shouldDirty: true,
                          });
                      }}
                      items={groupItems}
                      disabled={groupsQuery.isPending || groupsQuery.isError}
                    />
                  </Field>
                )}
              />
              {groupsQuery.isError && (
                <ApiErrorNotice
                  error={groupsQuery.error}
                  onRetry={() => {
                    void groupsQuery.refetch();
                  }}
                />
              )}
              <Controller
                name="allowedGroupIds"
                control={form.control}
                render={({ field }) => {
                  const visible = groups.filter((group) => group.status === 'active');
                  const hidden = field.value.filter(
                    (id) => !visible.some((group) => group.id === id),
                  );
                  return (
                    <fieldset
                      className="space-y-3 rounded-lg border border-[var(--color-border)] p-4"
                      disabled={saving || locked}
                    >
                      <legend className="px-1 text-sm font-medium">可访问分组</legend>
                      <p className="text-xs text-[var(--color-muted-foreground)]">
                        默认分组不可移除；未显示的已有授权会保留。
                      </p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {visible.map((group) => (
                          <label key={group.id} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={field.value.includes(group.id)}
                              disabled={group.id === form.getValues('groupId')}
                              onChange={(event) =>
                                field.onChange(
                                  event.currentTarget.checked
                                    ? [...new Set([...field.value, group.id])]
                                    : field.value.filter((id) => id !== group.id),
                                )
                              }
                            />
                            <span>{group.name}</span>
                          </label>
                        ))}
                      </div>
                      {hidden.length > 0 && (
                        <p className="break-all text-xs text-[var(--color-muted-foreground)]">
                          保留未显示授权：{hidden.join('、')}
                        </p>
                      )}
                      {groupsQuery.hasNextPage && (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          busy={groupsQuery.isFetchingNextPage}
                          onClick={() => {
                            void groupsQuery.fetchNextPage();
                          }}
                        >
                          加载更多分组
                        </Button>
                      )}
                    </fieldset>
                  );
                }}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="并发请求上限"
                  error={form.getFieldState('concurrencyLimit').error?.message}
                  description="留空表示不限。"
                >
                  <Input
                    {...form.register('concurrencyLimit')}
                    inputMode="numeric"
                    maxLength={16}
                  />
                </Field>
                <Field
                  label="每分钟请求上限"
                  error={form.getFieldState('rpmLimit').error?.message}
                  description="留空表示不限。"
                >
                  <Input {...form.register('rpmLimit')} inputMode="numeric" maxLength={16} />
                </Field>
              </div>
            </>
          )
        )}
        {mode === 'create' && groupsQuery.isError && (
          <ApiErrorNotice
            error={groupsQuery.error}
            onRetry={() => {
              void groupsQuery.refetch();
            }}
          />
        )}
        {mode === 'create' && groupsQuery.hasNextPage && (
          <Button
            type="button"
            variant="secondary"
            busy={groupsQuery.isFetchingNextPage}
            onClick={() => {
              void groupsQuery.fetchNextPage();
            }}
          >
            加载更多分组
          </Button>
        )}
        {mode === 'create' && groupsQuery.isPending && (
          <p role="status" className="text-xs text-[var(--color-muted-foreground)]">
            正在加载分组，也可留空使用默认分组。
          </p>
        )}
      </form>
    </Dialog>
  );
}
