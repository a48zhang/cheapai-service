import { z } from 'zod';
import { modelMappingInputSchema, protocolSchema } from '@cheapai/contracts/mappings';
import { builtinModel } from '@cheapai/model-catalog';
import type { ModelMappingPatch, ModelMappingView } from '@cheapai/api-client/mappings';

/** Convert UI fields once, then check the mapping contract. */
export const mappingDraftSchema = z
  .object({
    channelId: z.string().max(128),
    protocol: protocolSchema,
    upstreamModel: z.string(),
  })
  .pipe(modelMappingInputSchema);

export type MappingFormValues = z.input<typeof mappingDraftSchema>;
export type MappingFormOutput = z.output<typeof mappingDraftSchema>;

export function initialMappingFormValues(
  publicModelId: string,
  mapping?: ModelMappingView,
): MappingFormValues {
  const reference = mapping ? undefined : builtinModel(publicModelId);
  return {
    channelId: mapping?.channelId ?? '',
    protocol: mapping?.protocol ?? reference?.protocol ?? 'chat',
    upstreamModel: mapping?.upstreamModel ?? reference?.id ?? publicModelId,
  };
}

export function mappingKey(mapping: Pick<ModelMappingView, 'channelId' | 'protocol'>): string {
  return `${mapping.channelId}\u0000${mapping.protocol}`;
}

/** Preserve existing descriptive metadata when changing an upstream name. */
export function createMappingPatch(
  baseline: ModelMappingView,
  values: Pick<MappingFormOutput, 'upstreamModel'>,
): ModelMappingPatch | null {
  return baseline.upstreamModel === values.upstreamModel
    ? null
    : { upstreamModel: values.upstreamModel };
}
