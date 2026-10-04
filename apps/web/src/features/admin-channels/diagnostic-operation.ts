import type { ChannelModel, ChannelView } from '@cheapai/api-client/channels';
import type { ChannelProbeResult } from '@cheapai/api-client/channels';
import type { AdminChannelsApi } from './api';

export function channelModelKey(model: Pick<ChannelModel, 'publicModelId' | 'protocol'>): string {
  return `${model.publicModelId}|${model.protocol}`;
}

/** A single, explicit probe command; it cannot be retried or duplicated in the background. */
export function createDiagnosticOperation(api: AdminChannelsApi) {
  let active = false;

  return Object.freeze({
    async run(channel: ChannelView, model: ChannelModel): Promise<ChannelProbeResult> {
      if (active) throw new Error('A channel diagnostic is already running.');
      if (channel.status !== 'active') throw new Error('Only active channels can be diagnosed.');
      const currentMapping = channel.models.find(
        (candidate) =>
          candidate.publicModelId === model.publicModelId &&
          candidate.protocol === model.protocol &&
          candidate.upstreamModel === model.upstreamModel &&
          candidate.mappingVersion === model.mappingVersion &&
          candidate.priceVersion === model.priceVersion,
      );
      if (!currentMapping) throw new Error('The selected channel mapping is no longer available.');

      active = true;
      try {
        return await api.probe(channel.id, {
          publicModelId: currentMapping.publicModelId,
          protocol: currentMapping.protocol,
          channelVersion: channel.configVersion,
          mappingVersion: currentMapping.mappingVersion,
          priceVersion: currentMapping.priceVersion,
        });
      } finally {
        active = false;
      }
    },
  });
}
