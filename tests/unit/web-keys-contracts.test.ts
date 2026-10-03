import { describe, expect, it } from 'vitest';
import { createApiClient } from '@cheapai/api-client/client';
import { createKeysApi } from '@cheapai/api-client/keys';

function keysApiFor(data: unknown) {
  return createKeysApi(createApiClient({ fetch: async input => {
    expect(String(input)).toBe('/api/v1/account/key-groups');
    return Response.json({ data, request_id: 'key-groups-read' });
  } }));
}

describe('personal Key group response contract', () => {
  it('decodes groups from the standard success envelope data.items shape', async () => {
    const group = { id: 'default', name: '默认分组', models: ['cheapai-chat'] };

    await expect(keysApiFor({ items: [group] }).groups()).resolves.toEqual([group]);
  });

  it('rejects malformed group DTOs in a successful response', async () => {
    const api = keysApiFor({ items: [{ id: 'default', name: '默认分组', models: 'cheapai-chat' }] });

    await expect(api.groups()).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
