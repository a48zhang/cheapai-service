import {
  decodeSettings,
  decodeCodeBatch,
  decodeCodePage,
  codeRevocationSchema,
  type CodeBatchInput,
} from '@cheapai/contracts/registration-admin';
import type { ApiClient, ApiReadOptions } from './types.js';
export type {
  AdminRegistrationSettings,
  CodeMetadata,
  CodeListItem,
  CodeBatch,
  CodePage,
  CodeBatchInput,
} from '@cheapai/contracts/registration-admin';
export function createAdminRegistrationApi(client: ApiClient) {
  const settingsPath = '/api/v1/admin/registration/settings';
  const codesPath = '/api/v1/admin/registration/codes';
  return Object.freeze({
    async settings(readOptions?: ApiReadOptions) {
      return (
        await client.get(settingsPath, {
          decode: decodeSettings,
          ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
        })
      ).data;
    },
    async updateSettings(
      version: number,
      registrationMode: 'closed' | 'open' | 'invite',
      emailVerificationEnabled: boolean,
    ) {
      return (
        await client.patch(
          settingsPath,
          { version, registrationMode, emailVerificationEnabled },
          { decode: decodeSettings },
        )
      ).data;
    },
    async codes(
      options: { cursor?: string | null; creatorFilter?: string } = {},
      readOptions?: ApiReadOptions,
    ) {
      return (
        await client.get(codesPath, {
          query: { ...options, limit: 20 },
          decode: decodeCodePage,
          ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
        })
      ).data;
    },
    async revokeCode(id: string) {
      return (
        await client.post(
          `${codesPath}/${encodeURIComponent(id)}/revoke`,
          {},
          { decode: (value) => codeRevocationSchema.parse(value) },
        )
      ).data;
    },
    async createCodes(input: CodeBatchInput, operationId: string) {
      return (
        await client.post(
          codesPath,
          { ...input },
          { idempotencyKey: operationId, decode: decodeCodeBatch },
        )
      ).data;
    },
  });
}
export type AdminRegistrationApi = ReturnType<typeof createAdminRegistrationApi>;
