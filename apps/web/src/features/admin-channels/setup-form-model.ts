import { channelInputSchema } from '@cheapai/contracts/channels';
import { modelMappingInputSchema, protocolSchema } from '@cheapai/contracts/mappings';
import { builtinModel } from '@cheapai/model-catalog';
import type { ChannelInput } from '@cheapai/api-client/channels';
import type { Protocol } from '@cheapai/api-client/mappings';
import type { ChannelMappingDraft } from './setup-controller';
import { credentialInputError } from './credential-input';

export interface SetupChannelDraft {
  name: string;
  baseUrl: string;
  upstreamKey: string;
  priority: string;
}

export interface SetupMappingDraft {
  builtinId: string;
  publicModelId: string;
  protocol: Protocol;
  upstreamModel: string;
}

export function initialSetupChannelDraft(): SetupChannelDraft {
  return { name: '', baseUrl: '', upstreamKey: '', priority: '0' };
}

export function initialSetupMappingDraft(): SetupMappingDraft {
  return { builtinId: '', publicModelId: '', protocol: 'responses', upstreamModel: '' };
}

function readPriority(value: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const priority = Number(value);
  return Number.isSafeInteger(priority) ? priority : null;
}

export function validateSetupChannelDraft(draft: SetupChannelDraft): string | null {
  if (!channelInputSchema.shape.name.safeParse(draft.name).success) return '请输入有效的渠道名称。';
  if (!channelInputSchema.shape.baseUrl.safeParse(draft.baseUrl).success)
    return '请输入有效的上游 Base URL。';
  const credentialError = credentialInputError(draft.upstreamKey, true);
  if (credentialError) return credentialError;
  if (readPriority(draft.priority) === null) return '调度优先级必须是非负安全整数。';
  return null;
}

export function buildSetupChannelInput(draft: SetupChannelDraft): ChannelInput {
  const priority = readPriority(draft.priority);
  if (priority === null) throw new TypeError('Invalid channel setup priority.');
  return channelInputSchema.parse({
    name: draft.name,
    baseUrl: draft.baseUrl,
    upstreamKey: draft.upstreamKey,
    status: 'active',
    priority,
    concurrencyLimit: null,
    rpmLimit: null,
  });
}

export function validateSetupMappingDraft(draft: SetupMappingDraft): string | null {
  const validId = (value: string) =>
    modelMappingInputSchema.shape.upstreamModel.safeParse(value).success;
  if (
    !validId(draft.publicModelId) ||
    !validId(draft.upstreamModel) ||
    !protocolSchema.safeParse(draft.protocol).success
  ) {
    return '公开模型 ID 和上游模型 ID 必须使用有效标识格式。';
  }
  return null;
}

export function buildSetupMappingDraft(draft: SetupMappingDraft): ChannelMappingDraft {
  const protocol = protocolSchema.parse(draft.protocol);
  const upstreamModel = modelMappingInputSchema.shape.upstreamModel.parse(draft.upstreamModel);
  return { protocol, upstreamModel, capabilities: { protocol, features: [] } };
}

export function selectBuiltinReference(draft: SetupMappingDraft, value: string): SetupMappingDraft {
  const model = builtinModel(value);
  return {
    ...draft,
    builtinId: value,
    ...(model
      ? { publicModelId: model.id, protocol: model.protocol, upstreamModel: model.id }
      : {}),
  };
}

export function selectedBuiltinReference(draft: SetupMappingDraft) {
  return builtinModel(draft.builtinId);
}
