import {
  decodeKeyCreation,
  decodeKeyGroups,
  decodeKeyMetadata,
  decodeKeyRevocationResult,
  decodeKeysPage,
} from '@cheapai/contracts/keys';
import type {
  KeyCreation,
  KeyGroup,
  KeyInput,
  KeyMetadata,
  KeyRevocationResult,
  KeyState,
} from '@cheapai/contracts/keys';
import type { Page } from '@cheapai/contracts/common';
import type { ApiClient, ApiReadOptions } from './types.js';

export type {
  KeyCreation,
  KeyGroup,
  KeyInput,
  KeyMetadata,
  KeyRevocationResult,
  KeyState,
} from '@cheapai/contracts/keys';

export interface KeysApi {
  groups(readOptions?: ApiReadOptions): Promise<readonly KeyGroup[]>;
  list(
    options?: { readonly cursor?: string | null; readonly state?: KeyState },
    readOptions?: ApiReadOptions,
  ): Promise<Page<KeyMetadata>>;
  get(id: string, readOptions?: ApiReadOptions): Promise<KeyMetadata>;
  create(input: KeyInput, operationId: string): Promise<KeyCreation>;
  update(id: string, version: number, input: KeyInput): Promise<KeyMetadata>;
  revoke(id: string, version: number): Promise<KeyRevocationResult>;
}

const keyPath = (id: string): string => `/api/v1/keys/${encodeURIComponent(id)}`;

/** Personal keys share the supplied client for CSRF, session identity, and 401 handling. */
export function createKeysApi(client: ApiClient): KeysApi {
  return Object.freeze({
    async groups(readOptions?: ApiReadOptions): Promise<readonly KeyGroup[]> {
      return (
        await client.get('/api/v1/account/key-groups', {
          decode: decodeKeyGroups,
          ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
        })
      ).data;
    },
    async list(
      options: { readonly cursor?: string | null; readonly state?: KeyState } = {},
      readOptions?: ApiReadOptions,
    ): Promise<Page<KeyMetadata>> {
      return (
        await client.get('/api/v1/keys', {
          query: { ...options, limit: 20 },
          decode: decodeKeysPage,
          ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
        })
      ).data;
    },
    async get(id: string, readOptions?: ApiReadOptions): Promise<KeyMetadata> {
      return (
        await client.get(keyPath(id), {
          decode: decodeKeyMetadata,
          ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
        })
      ).data;
    },
    async create(input: KeyInput, operationId: string): Promise<KeyCreation> {
      return (
        await client.post(
          '/api/v1/keys',
          { ...input },
          {
            idempotencyKey: operationId,
            decode: decodeKeyCreation,
          },
        )
      ).data;
    },
    async update(id: string, version: number, input: KeyInput): Promise<KeyMetadata> {
      return (await client.patch(keyPath(id), { version, ...input }, { decode: decodeKeyMetadata }))
        .data;
    },
    async revoke(id: string, version: number): Promise<KeyRevocationResult> {
      return (
        await client.post(
          `${keyPath(id)}/revoke`,
          { version },
          { decode: decodeKeyRevocationResult },
        )
      ).data;
    },
  });
}
