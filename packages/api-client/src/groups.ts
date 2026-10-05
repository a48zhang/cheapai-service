import { groupPageSchema, groupSchema } from '@cheapai/contracts/groups';
import type {
  GroupInput,
  GroupListQuery,
  GroupPage,
  GroupPatch,
  GroupView,
} from '@cheapai/contracts/groups';
import type { ApiClient, ApiReadOptions } from './types.js';

export type {
  BillingMultiplier,
  GroupInput,
  GroupListQuery,
  GroupPage,
  GroupPatch,
  GroupStatus,
  GroupView,
} from '@cheapai/contracts/groups';

const pathFor = (id: string) => `/api/v1/admin/groups/${encodeURIComponent(id)}`;

export function createGroupsApi(api: ApiClient) {
  async function list(
    options: GroupListQuery = {},
    readOptions?: ApiReadOptions,
  ): Promise<GroupPage> {
    return (
      await api.get('/api/v1/admin/groups', {
        query: { ...options, limit: 20 },
        decode: (value) => groupPageSchema.parse(value),
        ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
      })
    ).data;
  }

  async function get(id: string, readOptions?: ApiReadOptions): Promise<GroupView> {
    return (
      await api.get(pathFor(id), {
        decode: (value) => groupSchema.parse(value),
        ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
      })
    ).data;
  }

  async function create(input: GroupInput): Promise<GroupView> {
    return (
      await api.post('/api/v1/admin/groups', input, {
        decode: (value) => groupSchema.parse(value),
      })
    ).data;
  }

  async function update(id: string, version: number, patch: GroupPatch): Promise<GroupView> {
    return (
      await api.patch(
        pathFor(id),
        { version, ...patch },
        {
          decode: (value) => groupSchema.parse(value),
        },
      )
    ).data;
  }

  return Object.freeze({
    list,
    async listAll(
      options: Pick<GroupListQuery, 'status'> = {},
      readOptions?: ApiReadOptions,
    ): Promise<readonly GroupView[]> {
      const groups = new Map<string, GroupView>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await list({ ...options, cursor }, readOptions);
        for (const group of page.items) groups.set(group.id, group);
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (seenCursors.has(cursor)) throw new TypeError('Repeated group pagination cursor.');
          seenCursors.add(cursor);
        }
      } while (cursor !== null);
      return [...groups.values()];
    },
    get,
    create,
    update,
  });
}

export const createAdminGroupsApi = createGroupsApi;
