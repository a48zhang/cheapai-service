import {
  decodeModel,
  decodeModelPage,
  modelInputSchema,
  modelPatchSchema,
} from '@cheapai/contracts/models';
import type { ModelInput, ModelPage, ModelPatch, ModelQuery, ModelView } from '@cheapai/contracts/models';
import type { ApiClient } from './types.js';

export type { ModelInput, ModelPage, ModelPatch, ModelQuery, ModelStatus, ModelView, SellPrices } from '@cheapai/contracts/models';
export { BILLABLE_BUCKETS } from '@cheapai/contracts/models';
export { decodeModel, decodeModelPage } from '@cheapai/contracts/models';

const collectionPath = '/api/v1/admin/models';
const modelPath = (publicModelId: string) => `${collectionPath}/${encodeURIComponent(publicModelId)}`;

/** Administrator model catalog CRUD. All writes use the server's optimistic priceVersion. */
export function createModelsApi(api: ApiClient) {
  return Object.freeze({
    async list(options: ModelQuery = {}): Promise<ModelPage> {
      return (await api.get(collectionPath, {
        query: { ...options, limit: 20 },
        decode: decodeModelPage,
      })).data;
    },
    async get(publicModelId: string): Promise<ModelView> {
      return (await api.get(modelPath(publicModelId), { decode: decodeModel })).data;
    },
    async create(input: ModelInput): Promise<ModelView> {
      const body = modelInputSchema.parse(input);
      return (await api.post(collectionPath, body, { decode: decodeModel })).data;
    },
    async update(publicModelId: string, priceVersion: number, input: ModelPatch): Promise<ModelView> {
      const patch = modelPatchSchema.parse(input);
      if (!Number.isSafeInteger(priceVersion) || priceVersion < 1) {
        throw new TypeError('Invalid administrator model price version.');
      }
      return (await api.patch(modelPath(publicModelId), { version: priceVersion, ...patch }, { decode: decodeModel })).data;
    },
  });
}

/** Explicit admin-named alias for callers that keep personal/admin API names together. */
export const createAdminModelsApi = createModelsApi;
