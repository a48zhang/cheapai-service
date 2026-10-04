import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyMetadata } from '@cheapai/api-client/keys';
import { createApiAccessApi, invalidateApiAccessKeys } from '../../features/api-access/api';
import { IntegrationGuide } from '../../features/api-access/IntegrationGuide';
import { KeyForm } from '../../features/api-access/KeyForm';
import { KeySecretDialog } from '../../features/api-access/KeySecretDialog';
import { KeyTable } from '../../features/api-access/KeyTable';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { Tabs } from '../../shared/ui/Tabs';
import { useSession } from '../../features/session/useSession';

interface SecretView {
  readonly value: string;
  readonly keyName: string;
}

export default function KeysPage() {
  const { user, epoch, client, queryClient } = useSession();
  const userId = user?.id ?? 'anonymous';
  const api = useMemo(() => createApiAccessApi(client), [client]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<KeyMetadata | null>(null);
  const [secret, setSecret] = useState<SecretView | null>(null);
  const previousIdentity = useRef({ userId, epoch });

  useLayoutEffect(() => {
    if (previousIdentity.current.userId !== userId || previousIdentity.current.epoch !== epoch) {
      previousIdentity.current = { userId, epoch };
      setCreateOpen(false);
      setEditing(null);
      setSecret(null);
    }
  }, [userId, epoch]);

  const formOpen = createOpen || editing !== null;
  const formProps =
    editing === null
      ? { open: formOpen, mode: 'create' as const }
      : { open: formOpen, mode: 'edit' as const, item: editing };
  const onKeyChanged = () => {
    void invalidateApiAccessKeys(queryClient, userId);
  };
  const changeFormOpen = (open: boolean) => {
    if (open) return;
    setCreateOpen(false);
    setEditing(null);
  };

  return (
    <main className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <PageHeader eyebrow="个人控制台" heading="API Keys" />
      <Tabs
        ariaLabel="API 接入"
        defaultValue="keys"
        items={[
          {
            value: 'keys',
            label: 'API Keys',
            content: (
              <div className="pt-5">
                <KeyTable
                  api={api}
                  userId={userId}
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
              </div>
            ),
          },
          {
            value: 'guide',
            label: '接入指南',
            content: (
              <div className="pt-5">
                <IntegrationGuide />
              </div>
            ),
          },
        ]}
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
    </main>
  );
}
