import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { GroupView } from '@cheapai/contracts/groups';
import type { ModelMappingView } from '@cheapai/contracts/mappings';
import { adminGroupsQueryKeys, recordGroupSaved } from '../../features/admin-groups/api';
import { modelMappingQueryKeys, recordMappingSaved } from '../../features/admin-models/mapping-api';

describe('resource cache updates', () => {
  it('updates saved group details and invalidates both lists and setup candidates for that actor', async () => {
    const client = new QueryClient();
    const saved: GroupView = {
      id: 'g',
      name: 'group',
      status: 'active',
      version: 2,
      channelIds: ['c'],
      billingMultiplier: '1',
      createdAt: 1,
      updatedAt: 2,
    };
    const listKey = adminGroupsQueryKeys.list('actor');
    const candidatesKey = adminGroupsQueryKeys.candidates('actor');
    const otherKey = adminGroupsQueryKeys.candidates('other');
    client.setQueryData(listKey, { pages: [{ items: [] }] });
    client.setQueryData(candidatesKey, []);
    client.setQueryData(otherKey, []);
    await recordGroupSaved(client, 'actor', saved);
    expect(client.getQueryData(adminGroupsQueryKeys.detail('actor', saved.id))).toBe(saved);
    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(candidatesKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false);
    const newer = { ...saved, version: 3, updatedAt: 3 };
    client.setQueryData(adminGroupsQueryKeys.detail('actor', saved.id), newer);
    await recordGroupSaved(client, 'actor', saved);
    expect(client.getQueryData(adminGroupsQueryKeys.detail('actor', saved.id))).toEqual(newer);
    client.clear();
  });

  it('does not let a detail read started before a save overwrite the saved version', async () => {
    const client = new QueryClient();
    const key = adminGroupsQueryKeys.detail('actor', 'g');
    const saved: GroupView = {
      id: 'g',
      name: 'saved',
      status: 'active',
      version: 2,
      channelIds: [],
      billingMultiplier: '1',
      createdAt: 1,
      updatedAt: 2,
    };
    let finish!: (value: GroupView) => void;
    const reading = client
      .fetchQuery({
        queryKey: key,
        queryFn: () =>
          new Promise<GroupView>((resolve) => {
            finish = resolve;
          }),
      })
      .catch(() => undefined);
    await recordGroupSaved(client, 'actor', saved);
    finish({ ...saved, name: 'old', version: 1, updatedAt: 1 });
    await reading;
    expect(client.getQueryData(key)).toEqual(saved);
    client.clear();
  });

  it('upserts the saved mapping once and does not downgrade a newer cached version', async () => {
    const client = new QueryClient();
    const mapping: ModelMappingView = {
      channelId: 'c',
      publicModelId: 'm',
      protocol: 'chat',
      upstreamModel: 'upstream',
      configVersion: 2,
      capabilities: { protocol: 'chat', features: [] },
    };
    const key = modelMappingQueryKeys.list('actor', 'm');
    client.setQueryData(key, { items: [{ ...mapping, configVersion: 1 }] });
    await recordMappingSaved(client, 'actor', mapping);
    expect(client.getQueryData(key)).toEqual({ items: [mapping] });
    await recordMappingSaved(client, 'actor', { ...mapping, configVersion: 1 });
    expect(client.getQueryData(key)).toEqual({ items: [mapping] });
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    client.clear();
  });
});
