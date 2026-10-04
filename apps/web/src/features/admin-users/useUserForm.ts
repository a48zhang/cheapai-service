import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { PublicUser } from '@cheapai/contracts/auth';
import type { UserPatch } from '@cheapai/api-client/users';
import type { AdminUsersApi } from './api';
import { flattenUserGroups, userGroupsQueryOptions } from './api';
import { withErrorContext } from '../../shared/lib/api-error';
import { initialUserFormValues, userFormSchema } from './user-form-model';
import type { ParsedUserFormValues, UserFormInitialState, UserFormValues } from './user-form-model';

type CommonProps = {
  readonly open: boolean;
  readonly api: AdminUsersApi;
  readonly actorId: string;
  readonly epoch: number;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: (user: PublicUser) => void;
};

export type UserFormProps = CommonProps & UserFormInitialState;

function isDefinitiveClientRejection(error: unknown): error is ApiClientError {
  return (
    error instanceof ApiClientError &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500
  );
}

/** Owns group reads, submit version, locks, error context, and reset lifecycle for UserForm. */
export function useUserForm(props: UserFormProps) {
  const { open, mode, api, actorId, epoch, onOpenChange, onSaved } = props;
  const user = mode === 'edit' ? props.user : null;
  const propsRef = useRef(props);
  const mountedRef = useRef(false);
  const openRef = useRef(open);
  const identityRef = useRef({
    actorId,
    epoch,
    mode,
    userId: user?.id ?? null,
    version: user?.version ?? null,
  });
  const saveRef = useRef(false);
  propsRef.current = props;
  openRef.current = open;
  identityRef.current = {
    actorId,
    epoch,
    mode,
    userId: user?.id ?? null,
    version: user?.version ?? null,
  };

  const groupsQuery = useInfiniteQuery({
    ...userGroupsQueryOptions(api, actorId, epoch),
    enabled: open,
  });
  const groups = useMemo(() => flattenUserGroups(groupsQuery.data?.pages), [groupsQuery.data]);
  const [saving, setSaving] = useState(false);
  const [locked, setLocked] = useState(false);
  const [message, setMessage] = useState<string | Error | null>(null);
  const form = useForm<UserFormValues, unknown, ParsedUserFormValues>({
    resolver: zodResolver(userFormSchema),
    defaultValues: initialUserFormValues(props),
  });
  const { reset } = form;

  useLayoutEffect(() => {
    if (!open) return;
    const current = propsRef.current;
    reset(initialUserFormValues(current));
    setLocked(false);
    setMessage(null);
  }, [open, mode, actorId, epoch, user?.id, user?.version, reset]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function close(nextOpen: boolean) {
    if (saveRef.current) return;
    onOpenChange(nextOpen);
  }

  const submit = form.handleSubmit(async (values: ParsedUserFormValues) => {
    if (saveRef.current || locked || values.mode !== mode) return;
    saveRef.current = true;
    setSaving(true);
    setMessage(null);
    const submitIdentity = {
      actorId,
      epoch,
      mode,
      userId: user?.id ?? null,
      version: user?.version ?? null,
    };
    const currentIdentity = () =>
      mountedRef.current &&
      openRef.current &&
      submitIdentity.actorId === identityRef.current.actorId &&
      submitIdentity.epoch === identityRef.current.epoch &&
      submitIdentity.mode === identityRef.current.mode &&
      submitIdentity.userId === identityRef.current.userId &&
      submitIdentity.version === identityRef.current.version;
    try {
      if (values.mode === 'create') {
        const created = await api.create({
          email: values.email,
          password: values.password,
          ...(values.groupId ? { groupId: values.groupId } : {}),
        });
        if (!currentIdentity()) return;
        onSaved(created);
        setMessage(`用户 ${created.email_normalized} 已创建。`);
        setLocked(true);
        return;
      }
      if (!user) return;
      if (
        values.groupId !== user.group_id &&
        !groups.some((group) => group.id === values.groupId && group.status === 'active')
      ) {
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
      if (!currentIdentity()) return;
      onSaved(updated);
      setMessage('用户设置已保存。');
      setLocked(true);
    } catch (error) {
      if (!currentIdentity()) return;
      if (mode === 'create' && isDefinitiveClientRejection(error)) {
        setMessage(withErrorContext(error, error.message));
      } else {
        setLocked(true);
        const message =
          mode === 'edit'
            ? error instanceof ApiClientError && error.status === 409
              ? '用户版本已变化，或触发最后管理员保护。请关闭后重新读取，再核对当前设置。'
              : '保存结果暂时无法确认。请关闭后重新读取用户状态；不会自动重试。'
            : '创建结果尚未确认，账户可能已经创建。请返回列表核对；本表单不会重复提交。';
        setMessage(withErrorContext(error, message));
      }
    } finally {
      saveRef.current = false;
      if (mountedRef.current) setSaving(false);
      if (values.mode === 'create') form.setValue('password', '');
    }
  });

  return { form, groupsQuery, groups, saving, locked, message, close, submit };
}
