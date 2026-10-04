import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ChatGroup, ChatModel } from '@cheapai/api-client/chat';
import { chatModelsQueryOptions } from '../api';
import type { ChatApiContext } from '../api';

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

function writeSelection(storage: Storage | null, owner: string, selection: ChatSelection): void {
  if (!storage) return;
  try {
    storage.setItem(`${storagePrefix}${owner}`, JSON.stringify(selection));
  } catch {
    // Private browsing and storage quotas must not prevent chatting.
  }
}

function findModel(
  groups: readonly ChatGroup[],
  selection: ChatSelection | null,
): {
  readonly group: ChatGroup | undefined;
  readonly model: ChatModel | undefined;
} {
  const group =
    selection?.groupId === null || selection === null
      ? undefined
      : groups.find((candidate) => candidate.id === selection.groupId);
  const model =
    group && selection?.modelId !== null && selection?.modelId !== undefined
      ? group.models.find((candidate) => candidate.publicModelId === selection.modelId)
      : undefined;
  return { group, model };
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
  const { group: selectedGroup, model: selectedModel } = useMemo(
    () => findModel(groups, selection),
    [groups, selection],
  );

  useEffect(() => {
    const saved = explicitSelection
      ? { groupId: conversationGroupId, modelId: conversationModelId }
      : readSelection(storage, owner);
    setRecord({ scopeKey, initialized: true, selection: saved ?? null });
  }, [conversationGroupId, conversationModelId, explicitSelection, owner, scopeKey, storage]);

  useEffect(() => {
    if (
      !activeRecord?.initialized ||
      explicitSelection ||
      selection !== null ||
      groups.length === 0
    )
      return;
    const firstGroup = groups.find((group) => group.models.length > 0);
    const firstModel = firstGroup?.models[0];
    if (!firstGroup || !firstModel) return;
    const next = { groupId: firstGroup.id, modelId: firstModel.publicModelId };
    setRecord({ scopeKey, initialized: true, selection: next });
    writeSelection(storage, owner, next);
  }, [activeRecord, explicitSelection, groups, owner, scopeKey, selection, storage]);

  const choose = useCallback(
    (next: ChatSelection) => {
      setRecord({ scopeKey, initialized: true, selection: next });
      writeSelection(storage, owner, next);
    },
    [owner, scopeKey, storage],
  );

  const selectGroup = useCallback(
    (groupId: string) => {
      const group = groups.find((candidate) => candidate.id === groupId);
      if (!group) return;
      choose({ groupId, modelId: group.models[0]?.publicModelId ?? null });
    },
    [choose, groups],
  );

  const selectModel = useCallback(
    (modelId: string) => {
      const group =
        selection?.groupId === null || selection === null
          ? undefined
          : groups.find((candidate) => candidate.id === selection.groupId);
      if (!group?.models.some((model) => model.publicModelId === modelId)) return;
      choose({ groupId: group.id, modelId });
    },
    [choose, groups, selection],
  );

  const unavailableReason =
    selection === null
      ? '请选择一个可用的模型组和模型。'
      : selectedGroup === undefined
        ? '当前会话使用的模型组已不可用。请选择其他模型组。'
        : selection.modelId === null
          ? '当前模型组没有可用模型，请选择其他模型组。'
          : selectedModel === undefined
            ? '当前会话使用的模型已不可用。请选择其他模型。'
            : null;

  const retry = useCallback(() => refetch(), [refetch]);

  return {
    groups,
    selection,
    selectedGroup,
    selectedModel,
    available: selection !== null && selectedGroup !== undefined && selectedModel !== undefined,
    unavailableReason,
    loading: isPending,
    refreshing: isRefetching && !isPending,
    error,
    errorMessage: error ? '授权模型读取失败。' : null,
    retry,
    selectGroup,
    selectModel,
  };
}
