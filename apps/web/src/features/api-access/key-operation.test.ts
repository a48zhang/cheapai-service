import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { KeyCreation, KeyInput, KeyMetadata, KeysApi } from '@cheapai/api-client/keys';
import { canEditAfterKeyCreateFailure, createKeyIntent, executeKeyCreate } from './key-operation';

const key = {
  id: 'key-1',
  userId: 'user-1',
  groupId: 'group-1',
  groupName: 'Default',
  name: 'fixture',
  displayPrefix: 's2a_key_ABCDEFGH',
  status: 'active',
  allowedModels: null,
  expiresAt: null,
  createdAt: 10,
  updatedAt: 10,
  version: 1,
} as const satisfies KeyMetadata;
const input: KeyInput = { name: 'fixture', groupId: 'group-1', expiresAt: null };
const intent = { operationId: 'operation-1', input };

describe('API key create operation recovery', () => {
  it('reuses the same intent after an uncertain response and sends the same idempotency key', async () => {
    const api = { create: vi.fn<KeysApi['create']>() } as unknown as KeysApi;
    const replay: KeyCreation = { kind: 'replayed', key };
    vi.mocked(api.create)
      .mockRejectedValueOnce(new Error('transport interrupted'))
      .mockResolvedValueOnce(replay);

    const first = intent;
    await expect(executeKeyCreate(api, first)).rejects.toThrow();
    const retry = createKeyIntent({ ...input, name: 'changed after timeout' }, first);
    expect(retry).toBe(first);
    await expect(executeKeyCreate(api, retry)).resolves.toEqual(replay);
    expect(api.create).toHaveBeenNthCalledWith(1, input, first.operationId);
    expect(api.create).toHaveBeenNthCalledWith(2, input, first.operationId);
  });

  it('allows correction only after definitive client-side rejection', () => {
    expect(
      canEditAfterKeyCreateFailure(new ApiClientError('api', 'ignored', { status: 400 })),
    ).toBe(true);
    expect(
      canEditAfterKeyCreateFailure(new ApiClientError('api', 'ignored', { status: 403 })),
    ).toBe(true);
    expect(
      canEditAfterKeyCreateFailure(new ApiClientError('api', 'ignored', { status: 409 })),
    ).toBe(false);
    expect(canEditAfterKeyCreateFailure(new ApiClientError('network', 'ignored'))).toBe(false);
  });
});
