import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { KeyMetadata } from '@cheapai/api-client/keys';
import {
  createApiAccessApi,
  invalidateApiAccessKeys,
  keyGroupsQueryOptions,
} from '../../features/api-access/api';
import { ApiBaseUrl, IntegrationGuide } from '../../features/api-access/IntegrationGuide';
import { integrationBaseUrl } from '../../features/api-access/integration-model';
import { KeyForm } from '../../features/api-access/KeyForm';
import { KeySecretDialog } from '../../features/api-access/KeySecretDialog';
import { KeyTable } from '../../features/api-access/KeyTable';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { useSession } from '../../features/session/useSession';

interface SecretView {
  readonly value: string;
  readonly keyName: string;
}

export default function KeysPage() {
  const { user, epoch, client, queryClient } = useSession();
  const userId = user?.id ?? 'anonymous';
  const api = useMemo(() => createApiAccessApi(client), [client]);
  const groupsQuery = useQuery({
    ...keyGroupsQueryOptions(api, userId),
    enabled: userId !== 'anonymous',
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<KeyMetadata | null>(null);
  const [secret, setSecret] = useState<SecretView | null>(null);
  const [selectedKey, setSelectedKey] = useState<KeyMetadata | null>(null);
  const previousIdentity = useRef({ userId, epoch });
  const baseUrl = integrationBaseUrl(window.location.origin);

  useLayoutEffect(() => {
    if (previousIdentity.current.userId !== userId || previousIdentity.current.epoch !== epoch) {
      previousIdentity.current = { userId, epoch };
      setCreateOpen(false);
      setEditing(null);
      setSecret(null);
      setSelectedKey(null);
    }
  }, [userId, epoch]);

  const formOpen = createOpen || editing !== null;
  const formProps =
    editing === null
      ? { open: formOpen, mode: 'create' as const }
      : { open: formOpen, mode: 'edit' as const, item: editing };
  const onKeyChanged = useCallback(
    (key: KeyMetadata) => {
      void invalidateApiAccessKeys(queryClient, userId);
      setSelectedKey((current) => {
        const usable =
          key.status === 'active' && (key.expiresAt === null || key.expiresAt > Date.now());
        if (usable) return key;
        return current?.id === key.id ? null : current;
      });
    },
    [queryClient, userId],
  );
  const onSelectKey = useCallback((key: KeyMetadata | null) => {
    setSelectedKey(key);
  }, []);
  const changeFormOpen = (open: boolean) => {
    if (open) return;
    setCreateOpen(false);
    setEditing(null);
  };

  return (
    <section className="space-y-6">
      <PageHeader heading="API 接入" />
      <ApiBaseUrl baseUrl={baseUrl} />
      <KeyTable
        api={api}
        userId={userId}
        selectedKeyId={selectedKey?.id ?? null}
        onSelectKey={onSelectKey}
        onCreate={() => {
          setEditing(null);
          setCreateOpen(true);
        }}
        onEdit={(key) => {
          setCreateOpen(false);
          setEditing(key);
        }}
        onChanged={onKeyChanged}
      />
      <IntegrationGuide
        baseUrl={baseUrl}
        groups={groupsQuery.data ?? []}
        selectedKey={selectedKey}
        groupsLoading={userId !== 'anonymous' && groupsQuery.isPending}
        groupsError={userId !== 'anonymous' && groupsQuery.isError ? '无法读取可用分组。' : null}
        onRetryGroups={() => void groupsQuery.refetch()}
      />
      <KeyForm
        {...formProps}
        api={api}
        userId={userId}
        epoch={epoch}
        onOpenChange={changeFormOpen}
        onChanged={onKeyChanged}
        onSecret={(value, keyName) => {
          if (
            previousIdentity.current.userId !== userId ||
            previousIdentity.current.epoch !== epoch
          )
            return;
          setCreateOpen(false);
          setEditing(null);
          setSecret({ value, keyName });
        }}
      />
      <KeySecretDialog
        secret={secret?.value ?? null}
        keyName={secret?.keyName ?? ''}
        onClose={() => setSecret(null)}
      />
    </section>
  );
}
