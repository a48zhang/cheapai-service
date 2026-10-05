import { z } from 'zod';
import {
  capabilityFeatureSchema,
  modelMappingInputSchema,
  protocolSchema,
} from '@cheapai/contracts/mappings';
import { builtinModel } from '@cheapai/model-catalog';
import type { ModelMappingPatch, ModelMappingView } from '@cheapai/api-client/mappings';

const capabilityDraftSchema = z.object({
  features: z.array(capabilityFeatureSchema),
  maxOutputTokens: z
    .string()
    .max(16)
    .refine(
      (value) =>
        value === '' || (/^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value))),
    ),
  reasoningEfforts: z.string().max(512),
  cacheTtls: z.array(z.string().min(1)),
});

/** UI draft fields are converted once, then checked by the public mapping contract. */
export const mappingDraftSchema = z
  .object({
    channelId: z.string().max(128),
    protocol: protocolSchema,
    upstreamModel: z
      .string()
      .max(128)
      .refine((value) => value.trim().length > 0),
    capabilities: capabilityDraftSchema,
  })
  .transform((value): z.input<typeof modelMappingInputSchema> => {
    const maxOutputTokens =
      value.capabilities.maxOutputTokens === ''
        ? undefined
        : Number(value.capabilities.maxOutputTokens);
    const reasoningEfforts = value.capabilities.reasoningEfforts.split(/[\s,]+/u).filter(Boolean);
    return {
      channelId: value.channelId,
      protocol: value.protocol,
      upstreamModel: value.upstreamModel.trim(),
      capabilities: {
        protocol: value.protocol,
        features: value.capabilities.features,
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        ...(reasoningEfforts.length === 0 ? {} : { reasoningEfforts }),
        ...(value.capabilities.cacheTtls.length === 0
          ? {}
          : { cacheTtls: value.capabilities.cacheTtls }),
      },
    };
  })
  .pipe(modelMappingInputSchema);

export type MappingFormValues = z.input<typeof mappingDraftSchema>;
export type MappingFormOutput = z.output<typeof mappingDraftSchema>;

function emptyCapabilities(
  features: MappingFormValues['capabilities']['features'] = [],
): MappingFormValues['capabilities'] {
  return {
    features: [...features],
    maxOutputTokens: '',
    reasoningEfforts: '',
    cacheTtls: [],
  };
}

export function initialMappingFormValues(
  publicModelId: string,
  mapping?: ModelMappingView,
): MappingFormValues {
  const reference = mapping ? undefined : builtinModel(publicModelId);
  const capabilities = mapping?.capabilities;
  return {
    channelId: mapping?.channelId ?? '',
    protocol: mapping?.protocol ?? reference?.protocol ?? 'chat',
    upstreamModel: mapping?.upstreamModel ?? reference?.id ?? publicModelId,
    capabilities: capabilities
      ? {
          features: [...capabilities.features],
          maxOutputTokens:
            capabilities.maxOutputTokens === undefined ? '' : String(capabilities.maxOutputTokens),
          reasoningEfforts: capabilities.reasoningEfforts?.join(', ') ?? '',
          cacheTtls: [...(capabilities.cacheTtls ?? [])],
        }
      : emptyCapabilities(reference ? ['tools'] : []),
  };
}

export function mappingKey(mapping: Pick<ModelMappingView, 'channelId' | 'protocol'>): string {
  return `${mapping.channelId}\u0000${mapping.protocol}`;
}

/** Builds a patch against the current server baseline while leaving configVersion separate. */
export function createMappingPatch(
  baseline: ModelMappingView,
  values: Pick<MappingFormOutput, 'upstreamModel' | 'capabilities'>,
): ModelMappingPatch | null {
  const patch: ModelMappingPatch = {
    ...(baseline.upstreamModel === values.upstreamModel
      ? {}
      : { upstreamModel: values.upstreamModel }),
    ...(JSON.stringify(baseline.capabilities) === JSON.stringify(values.capabilities)
      ? {}
      : { capabilities: values.capabilities }),
  };
  return Object.keys(patch).length === 0 ? null : patch;
}
