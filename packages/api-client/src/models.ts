import { decodeModel, decodeModelPage } from '@cheapai/contracts/models';
import type {
  ModelInput,
  ModelPage,
  ModelPatch,
  ModelQuery,
  ModelView,
} from '@cheapai/contracts/models';
import type { ApiClient, ApiReadOptions } from './types.js';

export type {
  ModelInput,
  ModelPage,
  ModelPatch,
  ModelQuery,
  ModelStatus,
  ModelView,
  SellPrices,
} from '@cheapai/contracts/models';
export { BILLABLE_BUCKETS } from '@cheapai/contracts/models';
export { decodeModel, decodeModelPage } from '@cheapai/contracts/models';

const collectionPath = '/api/v1/admin/models';
const modelPath = (publicModelId: string) =>
  `${collectionPath}/${encodeURIComponent(publicModelId)}`;

/** Administrator model catalog CRUD. All writes use the server's optimistic priceVersion. */
export function createModelsApi(api: ApiClient) {
  return Object.freeze({
    async list(options: ModelQuery = {}, readOptions?: ApiReadOptions): Promise<ModelPage> {
      return (
        await api.get(collectionPath, {
          query: { ...options, limit: 20 },
          decode: decodeModelPage,
          ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
        })
      ).data;
    },
    async get(publicModelId: string, readOptions?: ApiReadOptions): Promise<ModelView> {
      return (
        await api.get(modelPath(publicModelId), {
          decode: decodeModel,
          ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
        })
      ).data;
    },
    async create(input: ModelInput): Promise<ModelView> {
      return (await api.post(collectionPath, input, { decode: decodeModel })).data;
    },
    async update(
      publicModelId: string,
      priceVersion: number,
      input: ModelPatch,
    ): Promise<ModelView> {
      return (
        await api.patch(
          modelPath(publicModelId),
          { version: priceVersion, ...input },
          { decode: decodeModel },
        )
      ).data;
    },
  });
}

/** Explicit admin-named alias for callers that keep personal/admin API names together. */
export const createAdminModelsApi = createModelsApi;
