import {
  channelPageSchema,
  channelSchema,
  channelProbeResultSchema,
} from '@cheapai/contracts/channels';
import type {
  ChannelInput,
  ChannelListQuery,
  ChannelPage,
  ChannelPatch,
  ChannelProbeInput,
  ChannelProbeResult,
  ChannelView,
} from '@cheapai/contracts/channels';
import type { ApiClient, ApiReadOptions } from './types.js';

export type {
  ChannelInput,
  ChannelListQuery,
  ChannelModel,
  ChannelPage,
  ChannelPatch,
  ChannelProbeInput,
  ChannelProbeResult,
  ChannelProtocol,
  ChannelStatus,
  ChannelView,
} from '@cheapai/contracts/channels';

const pathFor = (id: string) => `/api/v1/admin/channels/${encodeURIComponent(id)}`;

export function createChannelsApi(api: ApiClient) {
  async function list(
    options: ChannelListQuery = {},
    readOptions?: ApiReadOptions,
  ): Promise<ChannelPage> {
    return (
      await api.get('/api/v1/admin/channels', {
        query: { ...options, limit: 20 },
        decode: (value) => channelPageSchema.parse(value),
        ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
      })
    ).data;
  }

  async function get(id: string, readOptions?: ApiReadOptions): Promise<ChannelView> {
    return (
      await api.get(pathFor(id), {
        decode: (value) => channelSchema.parse(value),
        ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
      })
    ).data;
  }

  async function create(input: ChannelInput): Promise<ChannelView> {
    return (
      await api.post('/api/v1/admin/channels', input, {
        decode: (value) => channelSchema.parse(value),
      })
    ).data;
  }

  async function update(id: string, version: number, patch: ChannelPatch): Promise<ChannelView> {
    return (
      await api.patch(
        pathFor(id),
        { version, ...patch },
        {
          decode: (value) => channelSchema.parse(value),
        },
      )
    ).data;
  }

  async function probe(id: string, input: ChannelProbeInput): Promise<ChannelProbeResult> {
    return (
      await api.post(`${pathFor(id)}/test`, input, {
        decode: (value) => channelProbeResultSchema.parse(value),
      })
    ).data;
  }

  return Object.freeze({
    list,
    async listAll(
      options: Pick<ChannelListQuery, 'status'> = {},
      readOptions?: ApiReadOptions,
    ): Promise<readonly ChannelView[]> {
      const items = new Map<string, ChannelView>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await list({ ...options, cursor }, readOptions);
        for (const item of page.items) items.set(item.id, item);
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (seenCursors.has(cursor)) throw new TypeError('Repeated channel pagination cursor.');
          seenCursors.add(cursor);
        }
      } while (cursor !== null);
      return [...items.values()];
    },
    get,
    create,
    update,
    probe,
  });
}

export const createAdminChannelsApi = createChannelsApi;
