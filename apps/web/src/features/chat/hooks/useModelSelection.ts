import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ChatGroup } from '@cheapai/api-client/chat';
import { chatModelsQueryOptions } from '../api';
import type { ChatApiContext } from '../api';
import { flattenModelOptions } from '../model/model-options';
import type { ChatModelOption, ModelSelectionIdentity } from '../model/model-options';

export interface ChatSelection {
  readonly groupId: string | null;
  readonly modelId: string | null;
}

export interface UseModelSelectionOptions {
  readonly context: ChatApiContext;
  readonly conversationId: string | null;
  /** Undefined means a new conversation; an object preserves that conversation's exact selection. */
  readonly conversationSelection?: ChatSelection;
  readonly storage?: Storage | null;
}

interface SelectionRecord {
  readonly scopeKey: string;
  readonly initialized: boolean;
  readonly selection: ChatSelection | null;
}

const storagePrefix = 'cheapai.chat.selection.v1:';
const emptyGroups: readonly ChatGroup[] = Object.freeze([]);
const emptyOptions: readonly ChatModelOption[] = Object.freeze([]);

function ownerKey(userId: string): string {
  return userId.length > 0 ? `user:${encodeURIComponent(userId)}` : 'anonymous';
}

function getStorage(explicitStorage?: Storage | null): Storage | null {
  if (explicitStorage !== undefined) return explicitStorage;
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readSelection(storage: Storage | null, owner: string): ChatSelection | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(`${storagePrefix}${owner}`);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const selection = value as Record<string, unknown>;
    if (
      (typeof selection.groupId !== 'string' && selection.groupId !== null) ||
      (typeof selection.modelId !== 'string' && selection.modelId !== null)
    )
      return null;
    return { groupId: selection.groupId, modelId: selection.modelId };
  } catch {
    return null;
  }
}

function writeSelection(
  storage: Storage | null,
  owner: string,
  selection: ModelSelectionIdentity,
): void {
  if (!storage) return;
  try {
    storage.setItem(`${storagePrefix}${owner}`, JSON.stringify(selection));
  } catch {
    // Private browsing and storage quotas must not prevent chatting.
  }
}

function clearSelection(storage: Storage | null, owner: string): void {
  if (!storage) return;
  try {
    storage.removeItem(`${storagePrefix}${owner}`);
  } catch {
    // Private browsing and storage quotas must not prevent chatting.
  }
}

/** Loads only server-authorized chat models and keeps selection scoped to its owner. */
export function useModelSelection({
  context,
  conversationId,
  conversationSelection,
  storage: explicitStorage,
}: UseModelSelectionOptions) {
  const query = useQuery(chatModelsQueryOptions(context));
  const { data: modelsData, error, isPending, isRefetching, refetch } = query;
  const groups = useMemo(() => modelsData?.items ?? emptyGroups, [modelsData?.items]);
  const options = useMemo(
    () => (modelsData === undefined ? emptyOptions : flattenModelOptions(groups)),
    [groups, modelsData],
  );
  const storage = useMemo(() => getStorage(explicitStorage), [explicitStorage]);
  const owner = ownerKey(context.userId);
  const explicitSelection = conversationSelection !== undefined;
  const conversationGroupId = conversationSelection?.groupId ?? null;
  const conversationModelId = conversationSelection?.modelId ?? null;
  const selectionInput = explicitSelection
    ? `${conversationGroupId ?? ''}:${conversationModelId ?? ''}`
    : 'preference';
  const scopeKey = JSON.stringify([
    owner,
    context.epoch,
    conversationId,
    explicitSelection ? ['conversation', conversationGroupId, conversationModelId] : selectionInput,
  ]);
  const [record, setRecord] = useState<SelectionRecord>({
    scopeKey: '',
    initialized: false,
    selection: null,
  });
  const activeRecord = record.scopeKey === scopeKey ? record : null;
  const selection = activeRecord?.selection ?? null;
  const selectedOption = useMemo(
    () =>
      selection?.groupId === null || selection?.modelId === null || selection === null
        ? undefined
        : options.find(
            (option) =>
              option.groupId === selection.groupId && option.modelId === selection.modelId,
          ),
    [options, selection],
  );
  const selectedGroup = selectedOption?.group;
  const selectedModel = selectedOption?.model;

  useEffect(() => {
    if (!explicitSelection) return;
    setRecord({
      scopeKey,
      initialized: true,
      selection: { groupId: conversationGroupId, modelId: conversationModelId },
    });
  }, [conversationGroupId, conversationModelId, explicitSelection, scopeKey]);

  useEffect(() => {
    if (explicitSelection || isPending || modelsData === undefined) return;
    const saved = readSelection(storage, owner);
    const savedOption =
      saved?.groupId && saved.modelId
        ? options.find(
            (option) => option.groupId === saved.groupId && option.modelId === saved.modelId,
          )
        : undefined;
    const fallback = savedOption ?? options[0];
    const next = fallback ? { groupId: fallback.groupId, modelId: fallback.modelId } : null;
    setRecord({ scopeKey, initialized: true, selection: next });
    if (next) writeSelection(storage, owner, next);
    else clearSelection(storage, owner);
  }, [explicitSelection, isPending, modelsData, options, owner, scopeKey, storage]);

  const selectOption = useCallback(
    (key: string) => {
      const option = options.find((candidate) => candidate.key === key);
      if (!option) return;
      const next = { groupId: option.groupId, modelId: option.modelId };
      setRecord({ scopeKey, initialized: true, selection: next });
      writeSelection(storage, owner, next);
    },
    [options, owner, scopeKey, storage],
  );

  const unavailableReason =
    selection === null
      ? '暂无可用模型'
      : selectedOption === undefined
        ? '此模型已不可用，请重新选择'
        : null;

  const retry = useCallback(() => refetch(), [refetch]);

  return {
    groups,
    options,
    selection,
    selectedOption,
    selectedGroup,
    selectedModel,
    available: selectedOption !== undefined,
    unavailableReason,
    loading: isPending,
    refreshing: isRefetching && !isPending,
    error,
    errorMessage: error ? '授权模型读取失败。' : null,
    retry,
    selectOption,
  };
}
