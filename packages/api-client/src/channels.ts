import {
  channelInputSchema,
  channelListQuerySchema,
  channelPageSchema,
  channelPatchSchema,
  channelProbeInputSchema,
  channelSchema,
  channelProbeResultSchema,
  channelVersionSchema,
} from '@cheapai/contracts/channels';
import type {
  ChannelInput,
  ChannelListQuery,
  ChannelPage,
  ChannelPatch,
  ChannelProbeInput,
  ChannelProbeResult,
  ChannelStatus,
  ChannelView,
} from '@cheapai/contracts/channels';
import { createAuthApi } from './auth.js';
import { createApiClient } from './client.js';
import { readCsrfCookie } from './csrf.js';
import type { ApiClient } from './types.js';

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

const defaultAuth = createAuthApi();
const defaultClient = createApiClient({
  getCsrfToken: async () => readCsrfCookie() ?? (await defaultAuth.bootstrap()).csrfToken,
});

const pathFor = (id: string) => `/api/v1/admin/channels/${encodeURIComponent(id)}`;

export function createChannelsApi(api: ApiClient = defaultClient) {
  async function list(options: ChannelListQuery = {}): Promise<ChannelPage> {
    const query = channelListQuerySchema.parse(options);
    return (await api.get('/api/v1/admin/channels', {
      query: { ...query, limit: 20 },
      decode: value => channelPageSchema.parse(value),
    })).data;
  }

  async function get(id: string): Promise<ChannelView> {
    return (await api.get(pathFor(id), { decode: value => channelSchema.parse(value) })).data;
  }

  async function create(input: ChannelInput): Promise<ChannelView> {
    const body = channelInputSchema.parse(input);
    return (await api.post('/api/v1/admin/channels', body, {
      decode: value => channelSchema.parse(value),
    })).data;
  }

  async function update(id: string, version: number, patch: ChannelPatch): Promise<ChannelView> {
    const body = channelPatchSchema.parse(patch);
    const expectedVersion = channelVersionSchema.parse(version);
    return (await api.patch(pathFor(id), { version: expectedVersion, ...body }, {
      decode: value => channelSchema.parse(value),
    })).data;
  }

  async function probe(id: string, input: ChannelProbeInput): Promise<ChannelProbeResult> {
    const body = channelProbeInputSchema.parse(input);
    return (await api.post(`${pathFor(id)}/test`, body, {
      decode: value => channelProbeResultSchema.parse(value),
    })).data;
  }

  return Object.freeze({
    list,
    async listAll(options: Pick<ChannelListQuery, 'status'> = {}): Promise<readonly ChannelView[]> {
      const items = new Map<string, ChannelView>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await list({ ...options, cursor });
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
    test: probe,
  });
}

export const createAdminChannelsApi = createChannelsApi;
export const channelsApi = createChannelsApi();
export const adminChannelsApi = channelsApi;
