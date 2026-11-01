import { decodeCatalog } from '@cheapai/contracts/catalog';
import type { ApiClient, ApiReadOptions } from './types.js';

/** Anonymous catalog; prices do not depend on the current session. */
export function createCatalogApi(api: ApiClient) {
  return {
    async list(options?: ApiReadOptions) {
      return (
        await api.get('/api/v1/catalog/models', {
          decode: decodeCatalog,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        })
      ).data;
    },
  };
}
