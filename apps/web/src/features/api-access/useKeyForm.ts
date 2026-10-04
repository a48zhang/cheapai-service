import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { KeyInput, KeyMetadata } from '@cheapai/api-client/keys';
import type { KeysApi } from '@cheapai/api-client/keys';
import { withErrorContext } from '../../shared/lib/api-error';
import { createKeyIntent, canEditAfterKeyCreateFailure, executeKeyCreate } from './key-operation';
import { idleKeyCreateOperation, reduceKeyCreateOperation } from './key-operation';
import type { KeyCreateOperation, KeyCreateOperationEvent } from './key-operation';
import { keyGroupsQueryOptions } from './api';
import {
  editedKeyExpiry,
  initialKeyFormValues,
  keyFormSchema,
  parseKeyExpiry,
} from './key-form-model';
import type { KeyFormValues } from './key-form-model';

type BusyLease = { readonly ownerKey: string };

export type KeyFormProps = {
  readonly open: boolean;
  readonly api: KeysApi;
  readonly userId: string;
  readonly epoch?: number;
  readonly onOpenChange: (open: boolean) => void;
  /** Called after create/replay or an edit so the owner-scoped list can refresh. */
  readonly onChanged: (key: KeyMetadata) => void;
  /** One-time cleartext travels only through this short-lived component callback. */
  readonly onSecret: (secret: string, keyName: string) => void;
} & (
  | { readonly mode: 'create'; readonly item?: never }
  | { readonly mode: 'edit'; readonly item: KeyMetadata }
);

/** Owns Key form state, owner-scoped reads, writes, and the uncertain-create lifecycle. */
export function useKeyForm(props: KeyFormProps) {
  const { open, mode, api, userId, epoch = 0, onOpenChange, onChanged, onSecret } = props;
  const ownerKey = JSON.stringify([userId, epoch]);
  const item = mode === 'edit' ? props.item : null;
  const groupsQuery = useQuery({ ...keyGroupsQueryOptions(api, userId), enabled: open });
  const [operation, setOperation] = useState<KeyCreateOperation>(idleKeyCreateOperation);
  const operationRef = useRef<KeyCreateOperation>(idleKeyCreateOperation);
  const [current, setCurrent] = useState<KeyMetadata | null>(item);
  const [notice, setNotice] = useState<string | Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const busyRef = useRef(false);
  const busyLeaseRef = useRef<BusyLease | null>(null);
  const mountedRef = useRef(false);
  const ownerKeyRef = useRef(ownerKey);
  const ownerAtMountRef = useRef(ownerKey);
  const previousOpenRef = useRef(false);
  const previousModeRef = useRef(mode);
  const previousItemIdRef = useRef(item?.id ?? null);
  const itemRef = useRef(item);
  const initialExpiryTextRef = useRef('');
  const form = useForm<KeyFormValues>({
    resolver: zodResolver(keyFormSchema),
    defaultValues: initialKeyFormValues(),
  });
  const { handleSubmit, reset, setValue, setError } = form;
  const groupId = form.watch('groupId');
  const groups = useMemo(() => groupsQuery.data ?? [], [groupsQuery.data]);
  const selectedGroup = groups.find((group) => group.id === groupId);

  ownerKeyRef.current = ownerKey;
  itemRef.current = item;

  function acquireBusyLease(): BusyLease {
    const lease = { ownerKey };
    busyLeaseRef.current = lease;
    busyRef.current = true;
    setBusy(true);
    return lease;
  }

  function releaseBusyLease(lease: BusyLease) {
    if (busyLeaseRef.current !== lease) return;
    busyLeaseRef.current = null;
    busyRef.current = false;
    if (mountedRef.current && lease.ownerKey === ownerKeyRef.current) setBusy(false);
  }

  function transition(event: KeyCreateOperationEvent) {
    const next = reduceKeyCreateOperation(operationRef.current, event);
    operationRef.current = next;
    setOperation(next);
  }

  const populate = useCallback(
    (key: KeyMetadata) => {
      setCurrent(key);
      const values = initialKeyFormValues(key);
      initialExpiryTextRef.current = values.expiresAt;
      reset(values);
    },
    [reset],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const currentItem = itemRef.current;
    const identityChanged = ownerAtMountRef.current !== ownerKey;
    const entryChanged =
      previousModeRef.current !== mode || previousItemIdRef.current !== (currentItem?.id ?? null);
    const justOpened = open && !previousOpenRef.current;
    if (identityChanged) {
      ownerAtMountRef.current = ownerKey;
      busyLeaseRef.current = null;
      busyRef.current = false;
      setBusy(false);
      operationRef.current = idleKeyCreateOperation;
      setOperation(idleKeyCreateOperation);
      setNotice(null);
      setCurrent(currentItem);
      const values = initialKeyFormValues(mode === 'edit' ? currentItem : null);
      reset(values);
      initialExpiryTextRef.current = values.expiresAt;
      setReloadNeeded(false);
    } else if (open && (justOpened || entryChanged)) {
      if (mode === 'edit' && currentItem) {
        populate(currentItem);
        setReloadNeeded(false);
      } else if (mode === 'create') {
        const phase = operationRef.current.status;
        const settled = phase === 'created' || phase === 'replayed';
        if (entryChanged || settled) {
          operationRef.current = idleKeyCreateOperation;
          setOperation(idleKeyCreateOperation);
          setNotice(null);
          const values = initialKeyFormValues();
          reset(values);
          initialExpiryTextRef.current = values.expiresAt;
        }
      }
    }
    previousOpenRef.current = open;
    previousModeRef.current = mode;
    previousItemIdRef.current = currentItem?.id ?? null;
  }, [open, mode, item?.id, ownerKey, reset, populate]);

  useEffect(() => {
    if (mode !== 'create' || !open || !groups.length) return;
    const matchingGroup = groups.find((group) => group.id === groupId);
    if (groups.length === 1 && matchingGroup === undefined) {
      setValue('groupId', groups[0]?.id ?? '');
    } else if (groups.length > 1 && matchingGroup === undefined && groupId !== '') {
      setValue('groupId', '');
    }
  }, [mode, open, groups, groupId, setValue]);

  function close(nextOpen: boolean, allowCompletedWrite = false) {
    if (!nextOpen && busyRef.current && !allowCompletedWrite) return;
    if (!nextOpen && operationRef.current.status !== 'unknown') {
      operationRef.current = idleKeyCreateOperation;
      setOperation(idleKeyCreateOperation);
      setCurrent(null);
      setNotice(null);
      setReloadNeeded(false);
      const values = initialKeyFormValues();
      reset(values);
      initialExpiryTextRef.current = values.expiresAt;
    }
    onOpenChange(nextOpen);
  }

  const submit = handleSubmit(async (values) => {
    if (busyRef.current) return;
    if (mode === 'create') {
      if (!selectedGroup) {
        setError('groupId', { message: '请选择管理员开放的分组。' });
        return;
      }
      const expiresAt = parseKeyExpiry(values.expiresAt);
      if (expiresAt === undefined || (expiresAt !== null && expiresAt <= Date.now())) {
        setError('expiresAt', { message: '到期时间必须是有效的未来时间。' });
        return;
      }
      const input: KeyInput = { name: values.name, expiresAt, groupId: values.groupId };
      const existingIntent =
        operationRef.current.status === 'unknown' || operationRef.current.status === 'correctable'
          ? operationRef.current.intent
          : null;
      const intent = createKeyIntent(input, existingIntent);
      transition({ type: 'submit', intent });
      const busyLease = acquireBusyLease();
      setNotice(null);
      const requestOwnerKey = ownerKey;
      try {
        const result = await executeKeyCreate(api, intent);
        if (!mountedRef.current || requestOwnerKey !== ownerKeyRef.current) return;
        onChanged(result.key);
        if (result.kind === 'created') {
          transition({ type: 'created', key: result.key });
          onSecret(result.token, result.key.name);
          close(false, true);
        } else {
          transition({ type: 'replayed', key: result.key });
          setNotice(
            '此操作已创建 Key，但服务端不会再次返回明文。请在列表确认；如未保存，可撤销该 Key 后新建。',
          );
        }
      } catch (error) {
        if (!mountedRef.current || requestOwnerKey !== ownerKeyRef.current) return;
        if (canEditAfterKeyCreateFailure(error)) {
          transition({ type: 'correctable' });
          setNotice(
            withErrorContext(
              error,
              error instanceof Error ? error.message : '请求未被接受，请修改参数后重试。',
            ),
          );
        } else {
          transition({ type: 'unknown' });
          setNotice(
            withErrorContext(
              error,
              '结果尚未确认。重试会沿用同一操作和参数；请勿刷新页面。关闭后重新打开仍可继续确认。',
            ),
          );
        }
      } finally {
        releaseBusyLease(busyLease);
      }
      return;
    }

    if (!current || current.status === 'revoked' || reloadNeeded) return;
    const expiresAt = editedKeyExpiry(
      values.expiresAt,
      current.expiresAt,
      initialExpiryTextRef.current,
    );
    if (
      expiresAt === undefined ||
      (values.expiresAt !== initialExpiryTextRef.current &&
        expiresAt !== null &&
        expiresAt <= Date.now())
    ) {
      setError('expiresAt', { message: '到期时间必须是有效的未来时间。' });
      return;
    }
    if (!groups.some((group) => group.id === values.groupId)) {
      setError('groupId', { message: '请选择当前可用的授权分组。' });
      return;
    }
    const busyLease = acquireBusyLease();
    setNotice(null);
    const requestOwnerKey = ownerKey;
    let saved = false;
    try {
      const updated = await api.update(current.id, current.version, {
        name: values.name,
        groupId: values.groupId,
        expiresAt,
      });
      if (!mountedRef.current || requestOwnerKey !== ownerKeyRef.current) return;
      populate(updated);
      onChanged(updated);
      saved = true;
    } catch (error) {
      if (!mountedRef.current || requestOwnerKey !== ownerKeyRef.current) return;
      setReloadNeeded(true);
      const message =
        error instanceof ApiClientError && error.status === 409
          ? 'Key 已发生变化或不可编辑。请重新读取并核对后再操作，不会自动覆盖其他修改。'
          : '操作结果未确认。请重新读取状态后再操作，不会自动重试。';
      setNotice(withErrorContext(error, message));
    } finally {
      releaseBusyLease(busyLease);
    }
    if (saved) close(false);
  });

  function modifyAfterFailure() {
    transition({ type: 'reset' });
    setNotice(null);
  }

  async function reloadCurrent() {
    if (!current || busyRef.current) return;
    const busyLease = acquireBusyLease();
    setNotice(null);
    const requestOwnerKey = ownerKey;
    try {
      void groupsQuery.refetch();
      const latest = await api.get(current.id);
      if (!mountedRef.current || requestOwnerKey !== ownerKeyRef.current) return;
      populate(latest);
      setReloadNeeded(false);
      setNotice('已读取最新状态，请核对表单后操作。');
      onChanged(latest);
    } catch (error) {
      if (mountedRef.current && requestOwnerKey === ownerKeyRef.current) {
        setNotice(withErrorContext(error, error instanceof Error ? error.message : '读取失败。'));
      }
    } finally {
      releaseBusyLease(busyLease);
    }
  }

  const createPhase = operation.status;
  const settled = createPhase === 'created' || createPhase === 'replayed';
  const fieldsDisabled =
    busy ||
    (mode === 'create' && createPhase !== 'idle') ||
    (mode === 'edit' && (reloadNeeded || current?.status === 'revoked'));
  const groupsError = groupsQuery.isError ? '无法读取可用分组，请重试。' : '';

  return {
    form,
    groupsQuery,
    groups,
    selectedGroup,
    current,
    notice,
    busy,
    reloadNeeded,
    createPhase,
    settled,
    fieldsDisabled,
    groupsError,
    close,
    submit,
    modifyAfterFailure,
    reloadCurrent,
  };
}
