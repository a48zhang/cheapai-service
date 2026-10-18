import type { ChatGroup, ChatModel } from '@cheapai/api-client/chat';

export interface ModelSelectionIdentity {
  readonly groupId: string;
  readonly modelId: string;
}

export interface ChatSelection {
  readonly groupId: string | null;
  readonly modelId: string | null;
}

export type ModelSelectionView =
  | { readonly kind: 'preparing' }
  | { readonly kind: 'error' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ready'; readonly option: ChatModelOption };

/** Explicit choices stay explicit, even when authorization changes. Only a new chat falls back. */
export function resolveModelSelection(
  options: readonly ChatModelOption[],
  explicit: ChatSelection | undefined,
  preference: ChatSelection | null,
): { selection: ChatSelection | null; option: ChatModelOption | undefined } {
  const find = (selection: ChatSelection | null | undefined) =>
    options.find(
      (option) => option.groupId === selection?.groupId && option.modelId === selection?.modelId,
    );
  if (explicit !== undefined) return { selection: explicit, option: find(explicit) };
  const option = find(preference) ?? options[0];
  return {
    selection: option ? { groupId: option.groupId, modelId: option.modelId } : null,
    option,
  };
}

export interface ChatModelOption extends ModelSelectionIdentity {
  readonly key: string;
  readonly group: ChatGroup;
  readonly model: ChatModel;
}

/** A canonical JSON tuple preserves the full group/model identity in controls. */
export function modelOptionKey(groupId: string, modelId: string): string {
  return JSON.stringify([groupId, modelId]);
}

/** Keeps one option per authorized (group, model) pair without cross-group deduplication. */
export function flattenModelOptions(groups: readonly ChatGroup[]): readonly ChatModelOption[] {
  return groups.flatMap((group) =>
    group.models.map((model) => ({
      key: modelOptionKey(group.id, model.publicModelId),
      groupId: group.id,
      modelId: model.publicModelId,
      group,
      model,
    })),
  );
}
