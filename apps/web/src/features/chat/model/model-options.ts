import type { ChatGroup, ChatModel } from '@cheapai/api-client/chat';

export interface ModelSelectionIdentity {
  readonly groupId: string;
  readonly modelId: string;
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
