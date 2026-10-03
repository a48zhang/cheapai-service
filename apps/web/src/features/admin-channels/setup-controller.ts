import type { ChannelInput, ChannelView } from '@cheapai/api-client/channels';
import type { ModelMappingInput, ModelMappingView } from '@cheapai/api-client/mappings';
import type { GroupPatch, GroupView } from '@cheapai/api-client/groups';

export type ChannelSetupStep = 'channel' | 'mapping' | 'group' | 'complete';

export interface ChannelSetupCommands {
  readonly createChannel: (input: ChannelInput) => Promise<ChannelView>;
  readonly createMapping: (publicModelId: string, input: ModelMappingInput) => Promise<ModelMappingView>;
  readonly updateGroup: (id: string, version: number, patch: GroupPatch) => Promise<GroupView>;
}

export interface ChannelSetupProgress {
  readonly step: ChannelSetupStep;
  readonly channel: ChannelView | null;
  readonly mapping: ModelMappingView | null;
  readonly group: GroupView | null;
  readonly error: Error | null;
}

export type ChannelMappingDraft = Omit<ModelMappingInput, 'channelId'>;

function initialProgress(): ChannelSetupProgress {
  return { step: 'channel', channel: null, mapping: null, group: null, error: null };
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error('配置步骤未能完成，请重试。');
}

/** Retains confirmed IDs and versions so resuming begins at the first unfinished operation. */
export function createChannelSetupController(commands: ChannelSetupCommands) {
  let progress = initialProgress();
  let active = false;

  async function createChannel(input: ChannelInput): Promise<ChannelSetupProgress> {
    if (active || progress.channel) return progress;
    active = true;
    try {
      const channel = await commands.createChannel(input);
      progress = { ...progress, channel, step: 'mapping', error: null };
    } catch (cause) {
      progress = { ...progress, step: 'channel', error: asError(cause) };
    } finally {
      active = false;
    }
    return progress;
  }

  async function createMapping(publicModelId: string, draft: ChannelMappingDraft): Promise<ChannelSetupProgress> {
    if (active || progress.mapping || !progress.channel) return progress;
    active = true;
    try {
      const mapping = await commands.createMapping(publicModelId, { ...draft, channelId: progress.channel.id });
      progress = { ...progress, mapping, step: 'group', error: null };
    } catch (cause) {
      progress = { ...progress, step: 'mapping', error: asError(cause) };
    } finally {
      active = false;
    }
    return progress;
  }

  async function updateGroup(group: GroupView): Promise<ChannelSetupProgress> {
    if (active || progress.group || !progress.channel || !progress.mapping) return progress;
    const channelId = progress.channel.id;
    if (group.channelIds.includes(channelId)) {
      progress = { ...progress, group, step: 'complete', error: null };
      return progress;
    }

    active = true;
    try {
      const patch: Pick<GroupPatch, 'channelIds'> = { channelIds: [...new Set([...group.channelIds, channelId])] };
      const updatedGroup = await commands.updateGroup(group.id, group.version, patch);
      progress = { ...progress, group: updatedGroup, step: 'complete', error: null };
    } catch (cause) {
      progress = { ...progress, step: 'group', error: asError(cause) };
    } finally {
      active = false;
    }
    return progress;
  }

  function reset(): ChannelSetupProgress {
    if (active) return progress;
    progress = initialProgress();
    return progress;
  }

  return Object.freeze({
    createChannel,
    createMapping,
    updateGroup,
    reset,
    getSnapshot: () => progress,
  });
}
