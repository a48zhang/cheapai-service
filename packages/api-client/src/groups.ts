import {
  groupInputSchema,
  groupListQuerySchema,
  groupPageSchema,
  groupPatchSchema,
  groupSchema,
  groupVersionSchema,
} from '@cheapai/contracts/groups';
import type {
  GroupInput,
  GroupListQuery,
  GroupPage,
  GroupPatch,
  GroupStatus,
  GroupView,
} from '@cheapai/contracts/groups';
import { createAuthApi } from './auth.js';
import { createApiClient } from './client.js';
import { readCsrfCookie } from './csrf.js';
import type { ApiClient } from './types.js';

export type {
  BillingMultiplier,
  GroupInput,
  GroupListQuery,
  GroupPage,
  GroupPatch,
  GroupStatus,
  GroupView,
} from '@cheapai/contracts/groups';

const defaultAuth = createAuthApi();
const defaultClient = createApiClient({
  getCsrfToken: async () => readCsrfCookie() ?? (await defaultAuth.bootstrap()).csrfToken,
});

const pathFor = (id: string) => `/api/v1/admin/groups/${encodeURIComponent(id)}`;

export function createGroupsApi(api: ApiClient = defaultClient) {
  async function list(options: GroupListQuery = {}): Promise<GroupPage> {
    const query = groupListQuerySchema.parse(options);
    return (await api.get('/api/v1/admin/groups', {
      query: { ...query, limit: 20 },
      decode: value => groupPageSchema.parse(value),
    })).data;
  }

  async function get(id: string): Promise<GroupView> {
    return (await api.get(pathFor(id), { decode: value => groupSchema.parse(value) })).data;
  }

  async function create(input: GroupInput): Promise<GroupView> {
    const body = groupInputSchema.parse(input);
    return (await api.post('/api/v1/admin/groups', body, {
      decode: value => groupSchema.parse(value),
    })).data;
  }

  async function update(id: string, version: number, patch: GroupPatch): Promise<GroupView> {
    const body = groupPatchSchema.parse(patch);
    const expectedVersion = groupVersionSchema.parse(version);
    return (await api.patch(pathFor(id), { version: expectedVersion, ...body }, {
      decode: value => groupSchema.parse(value),
    })).data;
  }

  return Object.freeze({
    list,
    async listAll(options: Pick<GroupListQuery, 'status'> = {}): Promise<readonly GroupView[]> {
      const groups = new Map<string, GroupView>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await list({ ...options, cursor });
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
export const groupsApi = createGroupsApi();
export const adminGroupsApi = groupsApi;
