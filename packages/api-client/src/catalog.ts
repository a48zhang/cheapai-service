import { catalogGroupsSchema, decodeCatalog } from '@cheapai/contracts/catalog';
import type { ApiClient, ApiReadOptions } from './types.js';

/** Anonymous catalog; prices do not depend on the current session. */
export function createCatalogApi(api: ApiClient) {
  return {
    async groups(options?: ApiReadOptions) {
      return (
        await api.get('/api/v1/catalog/groups', {
          decode: (value) => catalogGroupsSchema.parse(value),
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        })
      ).data;
    },
    async list(groupId: string, options?: ApiReadOptions) {
      return (
        await api.get('/api/v1/catalog/models', {
          query: { groupId },
          decode: decodeCatalog,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        })
      ).data;
    },
  };
}
