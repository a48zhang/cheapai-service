import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { KeyInput, KeyMetadata } from '@cheapai/api-client/keys';
import type { KeysApi } from '@cheapai/api-client/keys';
import { createKeyIntent, canEditAfterKeyCreateFailure, executeKeyCreate } from './key-operation';
import { idleKeyCreateOperation, reduceKeyCreateOperation } from './key-operation';
import type { KeyCreateOperation, KeyCreateOperationEvent } from './key-operation';
import { keyGroupsQueryOptions } from './api';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { useQuery } from '@tanstack/react-query';

const keyFormSchema = z.object({
  name: z.string().trim().min(1, '请输入 Key 名称。').max(128, '名称不能超过 128 个字符。'),
  groupId: z.string().min(1, '请选择管理员开放的分组。'),
  expiresAt: z.string(),
});

type KeyFormValues = z.infer<typeof keyFormSchema>;

type KeyFormProps = {
  readonly open: boolean;
  readonly api: KeysApi;
  readonly userId: string;
  readonly onOpenChange: (open: boolean) => void;
  /** Called after create/replay or an edit so the owner-scoped list can refresh. */
  readonly onChanged: (key: KeyMetadata) => void;
  /** One-time cleartext travels only through this short-lived component callback. */
  readonly onSecret: (secret: string, keyName: string) => void;
} & (
  | { readonly mode: 'create'; readonly item?: never }
  | { readonly mode: 'edit'; readonly item: KeyMetadata }
);

function localDateTime(timestamp: number | null): string {
  if (timestamp === null) return '';
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function timestampFromInput(value: string): number | null | undefined {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isSafeInteger(timestamp) ? timestamp : undefined;
}

export function KeyForm(props: KeyFormProps) {
  const { open, mode, api, userId, onOpenChange, onChanged, onSecret } = props;
  const item = mode === 'edit' ? props.item : null;
  const groupsQuery = useQuery({ ...keyGroupsQueryOptions(api, userId), enabled: open });
  const [operation, setOperation] = useState<KeyCreateOperation>(idleKeyCreateOperation);
  const operationRef = useRef<KeyCreateOperation>(idleKeyCreateOperation);
  const [current, setCurrent] = useState<KeyMetadata | null>(item);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const userIdRef = useRef(userId);
  const ownerAtMountRef = useRef(userId);
  const previousOpenRef = useRef(false);
  const previousModeRef = useRef(mode);
  const previousItemIdRef = useRef(item?.id ?? null);
  const itemRef = useRef(item);
  itemRef.current = item;
  const initialExpiryTextRef = useRef('');
  const { register, handleSubmit, reset, setValue, setError, watch, formState: { errors } } = useForm<KeyFormValues>({
    resolver: zodResolver(keyFormSchema),
    defaultValues: { name: '', groupId: '', expiresAt: '' },
  });
  const groupId = watch('groupId');
  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);
  const selectedGroup = groups.find(group => group.id === groupId);

  userIdRef.current = userId;

  const transition = (event: KeyCreateOperationEvent) => {
    const next = reduceKeyCreateOperation(operationRef.current, event);
    operationRef.current = next;
    setOperation(next);
  };

  const populate = useCallback((key: KeyMetadata) => {
    setCurrent(key);
    const expiryText = localDateTime(key.expiresAt);
    initialExpiryTextRef.current = expiryText;
    reset({ name: key.name, groupId: key.groupId, expiresAt: expiryText });
  }, [reset]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const currentItem = itemRef.current;
    const identityChanged = ownerAtMountRef.current !== userId;
    const entryChanged = previousModeRef.current !== mode || previousItemIdRef.current !== (currentItem?.id ?? null);
    const justOpened = open && !previousOpenRef.current;
    if (identityChanged) {
      ownerAtMountRef.current = userId;
      operationRef.current = idleKeyCreateOperation;
      setOperation(idleKeyCreateOperation);
      setMessage('');
      setCurrent(currentItem);
      reset(mode === 'edit' && currentItem ? { name: currentItem.name, groupId: currentItem.groupId, expiresAt: localDateTime(currentItem.expiresAt) }
        : { name: '', groupId: '', expiresAt: '' });
      initialExpiryTextRef.current = mode === 'edit' && currentItem ? localDateTime(currentItem.expiresAt) : '';
      setReloadNeeded(false);
    } else if (open && (justOpened || entryChanged)) {
      if (mode === 'edit' && currentItem) {
        populate(currentItem);
        setReloadNeeded(false);
      } else if (mode === 'create') {
        const settled = operationRef.current.status === 'created' || operationRef.current.status === 'replayed';
        if (entryChanged || settled) {
          operationRef.current = idleKeyCreateOperation;
          setOperation(idleKeyCreateOperation);
          setMessage('');
          reset({ name: '', groupId: '', expiresAt: '' });
        }
      }
    }
    previousOpenRef.current = open;
    previousModeRef.current = mode;
    previousItemIdRef.current = currentItem?.id ?? null;
  }, [open, mode, item?.id, userId, reset, populate]);

  useEffect(() => {
    if (mode !== 'create' || !open || !groups.length) return;
    if (!groups.some(group => group.id === groupId)) setValue('groupId', groups[0]?.id ?? '');
  }, [mode, open, groups, groupId, setValue]);

  const close = (nextOpen: boolean) => {
    if (!nextOpen && busyRef.current) return;
    onOpenChange(nextOpen);
  };

  const submit = handleSubmit(async values => {
    if (busyRef.current) return;
    if (mode === 'create') {
      if (!selectedGroup) {
        setError('groupId', { message: '请选择管理员开放的分组。' });
        return;
      }
      const expiresAt = timestampFromInput(values.expiresAt);
      if (expiresAt === undefined || (expiresAt !== null && expiresAt <= Date.now())) {
        setError('expiresAt', { message: '到期时间必须是有效的未来时间。' });
        return;
      }
      const input: KeyInput = { name: values.name, expiresAt, groupId: values.groupId };
      const existingIntent = operationRef.current.status === 'unknown' || operationRef.current.status === 'correctable'
        ? operationRef.current.intent : null;
      const intent = createKeyIntent(input, existingIntent);
      transition({ type: 'submit', intent });
      busyRef.current = true;
      setBusy(true);
      setMessage('');
      const ownerId = userId;
      try {
        const result = await executeKeyCreate(api, intent);
        if (!mountedRef.current || ownerId !== userIdRef.current) return;
        onChanged(result.key);
        if (result.kind === 'created') {
          transition({ type: 'created', key: result.key });
          onSecret(result.token, result.key.name);
          onOpenChange(false);
        } else {
          transition({ type: 'replayed', key: result.key });
          setMessage('此操作已创建 Key，但服务端不会再次返回明文。请在列表确认；如未保存，可撤销该 Key 后新建。');
        }
      } catch (error) {
        if (!mountedRef.current || ownerId !== userIdRef.current) return;
        if (canEditAfterKeyCreateFailure(error)) {
          transition({ type: 'correctable' });
          setMessage(error instanceof Error ? error.message : '请求未被接受，请修改参数后重试。');
        } else {
          transition({ type: 'unknown' });
          setMessage('结果尚未确认。重试会沿用同一操作和参数；请勿刷新页面。关闭后重新打开仍可继续确认。');
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current && ownerId === userIdRef.current) setBusy(false);
      }
      return;
    }

    if (!current || current.status === 'revoked' || reloadNeeded) return;
    const expiresAt = values.expiresAt === initialExpiryTextRef.current
      ? current.expiresAt : timestampFromInput(values.expiresAt);
    if (expiresAt === undefined || (values.expiresAt !== initialExpiryTextRef.current && expiresAt !== null && expiresAt <= Date.now())) {
      setError('expiresAt', { message: '到期时间必须是有效的未来时间。' });
      return;
    }
    if (!groups.some(group => group.id === values.groupId)) {
      setError('groupId', { message: '请选择当前可用的授权分组。' });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessage('');
    const ownerId = userId;
    try {
      const updated = await api.update(current.id, current.version, {
        name: values.name,
        groupId: values.groupId,
        expiresAt,
      });
      if (!mountedRef.current || ownerId !== userIdRef.current) return;
      populate(updated);
      setMessage('Key 已保存。');
      onChanged(updated);
    } catch (error) {
      if (!mountedRef.current || ownerId !== userIdRef.current) return;
      setReloadNeeded(true);
      setMessage(error instanceof ApiClientError && error.status === 409
        ? 'Key 已发生变化或不可编辑。请重新读取并核对后再操作，不会自动覆盖其他修改。'
        : '操作结果未确认。请重新读取状态后再操作，不会自动重试。');
    } finally {
      busyRef.current = false;
      if (mountedRef.current && ownerId === userIdRef.current) setBusy(false);
    }
  });

  const modifyAfterFailure = () => {
    transition({ type: 'reset' });
    setMessage('');
  };

  const reloadCurrent = async () => {
    if (!current || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage('');
    const ownerId = userId;
    try {
      void groupsQuery.refetch();
      const latest = await api.get(current.id);
      if (!mountedRef.current || ownerId !== userIdRef.current) return;
      populate(latest);
      setReloadNeeded(false);
      setMessage('已读取最新状态，请核对表单后操作。');
      onChanged(latest);
    } catch (error) {
      if (mountedRef.current && ownerId === userIdRef.current) {
        setMessage(error instanceof Error ? error.message : '读取失败。');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current && ownerId === userIdRef.current) setBusy(false);
    }
  };

  const createPhase = operation.status;
  const settled = createPhase === 'created' || createPhase === 'replayed';
  const fieldsDisabled = busy || (mode === 'create' && createPhase !== 'idle')
    || (mode === 'edit' && (reloadNeeded || current?.status === 'revoked'));
  const groupsError = groupsQuery.isError ? '无法读取可用分组，请重试。' : '';

  const footer = (
    <>
      {reloadNeeded && <Button variant="secondary" busy={busy} onClick={() => void reloadCurrent()}>重新读取</Button>}
      {mode === 'create' && createPhase === 'correctable' && (
        <Button variant="secondary" onClick={modifyAfterFailure}>修改参数</Button>
      )}
      <Button variant="outline" disabled={busy} onClick={() => close(false)}>
        {mode === 'create' && createPhase === 'created' ? '已保存，关闭密钥' : '关闭'}
      </Button>
      {mode === 'create' && !settled && createPhase !== 'correctable' && (
        <Button type="submit" form="key-form" busy={busy} disabled={groupsQuery.isLoading || groupsError !== '' || !selectedGroup}>
          {busy ? '正在确认…' : createPhase === 'unknown' ? '重试确认' : '创建 Key'}
        </Button>
      )}
      {mode === 'edit' && current?.status !== 'revoked' && (
        <Button type="submit" form="key-form" busy={busy} disabled={groupsQuery.isLoading || groupsError !== '' || reloadNeeded}>
          保存 Key
        </Button>
      )}
    </>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={mode === 'create' ? '创建 API Key' : '编辑 Key'}
      description={mode === 'create' ? '密钥只在创建成功时显示一次，请立即保存。' : '更新授权分组或到期时间会增加 Key 版本。'}
      closeLabel={mode === 'create' ? '关闭创建 API Key' : '关闭编辑 Key'}
      closeButton={!busy}
      footer={footer}
    >
      {message && <p role="status" className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)] p-3 text-sm">{message}</p>}
      {mode === 'edit' && current?.status === 'revoked' && <p className="mb-4 text-sm text-[var(--color-muted-foreground)]">此 Key 已撤销。</p>}
      {mode === 'edit' && current && <p className="mb-4"><code>{current.displayPrefix}…</code></p>}
      {mode === 'create' && createPhase === 'replayed' ? null : mode === 'create' && createPhase === 'created' ? null : (
        <form id="key-form" className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <fieldset disabled={fieldsDisabled} className="space-y-4 border-0 p-0">
            <Field label="名称" required error={errors.name?.message}>
              <Input autoComplete="off" maxLength={128} {...register('name')} />
            </Field>
            <Field label="分组" required error={errors.groupId?.message}>
              <select {...register('groupId')} required disabled={groupsQuery.isLoading || fieldsDisabled}
                className="min-h-10 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:cursor-not-allowed disabled:opacity-60">
                <option value="" disabled>选择分组</option>
                {mode === 'edit' && current && !groups.some(group => group.id === current.groupId) && (
                  <option value={current.groupId} disabled>{current.groupName}（授权已撤回）</option>
                )}
                {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </Field>
            {groupsQuery.isLoading && <p role="status" className="text-sm text-[var(--color-muted-foreground)]">正在读取可用分组…</p>}
            {groupsError && <div role="alert" className="flex items-center justify-between gap-3 text-sm text-[var(--color-destructive)]">
              <span>{groupsError}</span><Button variant="secondary" size="sm" onClick={() => void groupsQuery.refetch()}>重试</Button>
            </div>}
            {!groupsQuery.isLoading && !groupsError && groups.length === 0 && mode === 'create' && (
              <p className="text-sm text-[var(--color-muted-foreground)]">暂无可用分组，请联系管理员开放。</p>
            )}
            {selectedGroup && <div className="rounded-lg bg-[var(--color-muted)] p-3 text-sm">
              {selectedGroup.models.length === 0
                ? <span>该分组尚未配置模型</span>
                : <ul className="flex flex-wrap gap-2">{selectedGroup.models.map(model => <li key={model}><code>{model}</code></li>)}</ul>}
            </div>}
            <Field label="到期时间（留空不过期）" error={errors.expiresAt?.message}>
              <Input type="datetime-local" {...register('expiresAt')} />
            </Field>
          </fieldset>
        </form>
      )}
    </Dialog>
  );
}
