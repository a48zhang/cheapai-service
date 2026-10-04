import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chatDraftStorageKey, createChatDraftStore } from '../model/drafts';
import type { ChatDraftScope, ChatDraftStore } from '../model/drafts';

export type DraftSessionStatus = 'unknown' | 'anonymous' | 'authenticated' | 'unavailable';

/** The small identity surface needed by drafts; callers adapt the session snapshot. */
export interface DraftIdentity {
  readonly status: DraftSessionStatus;
  readonly userId: string | null;
  readonly expiredUserId?: string | null | undefined;
}

export interface UseDraftOptions {
  readonly identity: DraftIdentity;
  readonly conversationId: string | null;
  readonly storage?: Storage | null | undefined;
}

interface DraftValue {
  readonly scopeKey: string;
  readonly value: string;
}

function ownerId(identity: DraftIdentity): string | null {
  if (identity.status === 'authenticated' && identity.userId !== null) return identity.userId;
  return identity.expiredUserId ?? null;
}

/**
 * Keeps the active draft in memory while isolating persistence by user and
 * conversation. Expired identities keep the same user scope for recovery.
 */
export function useDraft({ identity, conversationId, storage }: UseDraftOptions) {
  const store = useMemo<ChatDraftStore>(() => createChatDraftStore(storage), [storage]);
  const activeUserId = ownerId(identity);
  const scope = useMemo<ChatDraftScope>(
    () => ({ userId: activeUserId, conversationId }),
    [activeUserId, conversationId],
  );
  const scopeKey = chatDraftStorageKey(scope);
  const [record, setRecord] = useState<DraftValue>({ scopeKey: '', value: '' });
  const recordRef = useRef(record);
  const activeScopeRef = useRef<{ readonly key: string; readonly scope: ChatDraftScope } | null>(
    null,
  );
  const previousScopeRef = useRef<ChatDraftScope | null>(null);

  useEffect(() => {
    const previousScope = previousScopeRef.current;
    const explicitlySignedOut =
      previousScope?.userId !== null &&
      previousScope?.userId !== undefined &&
      identity.status === 'anonymous' &&
      identity.expiredUserId == null;
    if (explicitlySignedOut && previousScope) store.remove(previousScope);

    // A draft typed immediately after an identity/route transition belongs to
    // the newly rendered scope and wins over a previously saved value there.
    const currentInput = recordRef.current.scopeKey === scopeKey ? recordRef.current.value : null;
    const savedValue =
      identity.status === 'authenticated' && identity.userId !== null
        ? store.claimAnonymous(identity.userId, conversationId)
        : store.read(scope);
    const value = currentInput ?? savedValue ?? '';
    store.write(scope, value);

    const nextRecord = { scopeKey, value };
    recordRef.current = nextRecord;
    setRecord(nextRecord);
    activeScopeRef.current = { key: scopeKey, scope };
    previousScopeRef.current = scope;
  }, [
    conversationId,
    identity.expiredUserId,
    identity.status,
    identity.userId,
    scope,
    scopeKey,
    store,
  ]);

  const setDraft = useCallback(
    (value: string) => {
      const nextRecord = { scopeKey, value };
      recordRef.current = nextRecord;
      setRecord(nextRecord);
      if (activeScopeRef.current?.key === scopeKey) store.write(scope, value);
    },
    [scopeKey, scope, store],
  );

  /** Save interrupted input only to the identity that owned the operation. */
  const preservePending = useCallback(
    (value: string, operationUserId: string | null) => {
      if (operationUserId !== scope.userId) return;
      if (activeScopeRef.current?.key !== scopeKey) return;
      const nextRecord = { scopeKey, value };
      recordRef.current = nextRecord;
      setRecord(nextRecord);
      store.write(scope, value);
    },
    [scope, scopeKey, store],
  );

  return {
    draft: record.scopeKey === scopeKey ? record.value : '',
    setDraft,
    preservePending,
  };
}
