import {
  imageChoicesSchema,
  imageJobPageSchema,
  imageJobSchema,
  imageModelsSchema,
  imageModelSchema,
} from '@cheapai/contracts/images';
import type { ImageGenerateInput, ImageModelInput } from '@cheapai/contracts/images';
import type { ApiClient } from './types.js';

export function createImagesApi(client: ApiClient) {
  const root = '/api/v1/images';
  return {
    models: () =>
      client
        .get(`${root}/models`, { decode: (value) => imageChoicesSchema.parse(value) })
        .then((value) => value.data),
    history: (cursor?: string | null) =>
      client
        .get(`${root}/generations`, {
          query: { cursor },
          decode: (value) => imageJobPageSchema.parse(value),
        })
        .then((value) => value.data),
    get: (id: string) =>
      client
        .get(`${root}/generations/${encodeURIComponent(id)}`, {
          decode: (value) => imageJobSchema.parse(value),
        })
        .then((value) => value.data),
    generate: (input: ImageGenerateInput) =>
      client
        .post(`${root}/generations`, input, { decode: (value) => imageJobSchema.parse(value) })
        .then((value) => value.data),
    adminModels: () =>
      client
        .get('/api/v1/admin/image-models', { decode: (value) => imageModelsSchema.parse(value) })
        .then((value) => value.data),
    saveModel: (input: ImageModelInput, existing?: { id: string; version: number }) =>
      existing
        ? client
            .patch(
              `/api/v1/admin/image-models/${encodeURIComponent(existing.id)}`,
              { ...input, version: existing.version },
              { decode: (value) => imageModelSchema.parse(value) },
            )
            .then((value) => value.data)
        : client
            .post('/api/v1/admin/image-models', input, {
              decode: (value) => imageModelSchema.parse(value),
            })
            .then((value) => value.data),
  };
}

export function imageContentUrl(id: string, download = false): string {
  return `/api/v1/images/generations/${encodeURIComponent(id)}/content${download ? '?download=1' : ''}`;
}
