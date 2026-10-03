import { beforeEach, describe, expect, it } from 'vitest';
import { createModelMapping, getModelMapping, listModelMappings, updateModelMapping, validateMappingCapabilities } from '../../apps/worker/admin/model-mappings';
import type { ModelMappingInput } from '../../apps/worker/admin/model-mappings';
import { createChannel } from '../../apps/worker/admin/channel-repository';
import { createModel } from '../../apps/worker/admin/model-repository';
import { testEnv } from '../helpers/database';

let channelId: string;
const modelId = 'c10-public';

describe('C10-OUTPUT-CONFIG scoped extension declarations', () => {
  it('recognizes output_config only for native Messages declarations', () => {
    const capabilities = { protocol: 'messages', features: [], nativeExtensions: [{ scope: 'output_config', name: 'vendor_option' }] };
    expect(validateMappingCapabilities(capabilities, 'messages')).toMatchObject({ nativeExtensions: capabilities.nativeExtensions });
    expect(() => validateMappingCapabilities({ ...capabilities, protocol: 'chat' }, 'chat')).toThrow();
    expect(() => validateMappingCapabilities({ ...capabilities, protocol: 'responses' }, 'responses')).toThrow();
  });
  it.each(['authorization', 'headers', 'api_key', 'base_url', 'url', 'host', 'constructor', 'prototype'])('keeps prohibited field %s blocked under the new scope', name => {
    expect(() => validateMappingCapabilities({ protocol: 'messages', features: [], nativeExtensions: [{ scope: 'output_config', name }] }, 'messages')).toThrow();
  });
  it('does not enable wildcard names, unknown scopes or extra declaration fields', () => {
    for (const extension of [{ scope: 'output_config', name: '*' }, { scope: 'output_config_any', name: 'vendor' }, { scope: 'output_config', name: 'vendor', allowAll: true }]) {
      expect(() => validateMappingCapabilities({ protocol: 'messages', features: [], nativeExtensions: [extension] }, 'messages')).toThrow();
    }
  });
});
const context = (operationId: string) => ({ actorId: 'c10-admin', operationId, now: 2000 });
function mapping(protocol: 'chat' | 'responses' | 'messages' = 'chat'): ModelMappingInput {
  return { channelId, publicModelId: modelId, protocol, upstreamModel: `provider-${protocol}`, capabilities: { protocol, features: [], maxOutputTokens: 8192 } };
}
const key = (protocol: 'chat' | 'responses' | 'messages' = 'chat') => ({ channelId, publicModelId: modelId, protocol });
async function audits() { return (await testEnv.DB.prepare("SELECT * FROM admin_audit WHERE target_type='channel_model'").all()).results; }

describe('channel/model/protocol mappings on native D1', () => {
  beforeEach(async () => {
    await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES ('c10-group','C10 group','active',1,0,0)").run();
    await testEnv.DB.prepare(`INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES ('c10-admin','c10@example.invalid','test-only','admin','active','c10-group',2,60,'admin',0,0)`).run();
    const channel = await createChannel(testEnv.DB, { name: 'C10 channel', baseUrl: 'https://provider.example.com', upstreamKey: 'test-key', concurrencyLimit: 2, rpmLimit: 60 }, context('channel'), { keyVersion: 'v1', key: crypto.getRandomValues(new Uint8Array(32)) });
    channelId = channel.id;
    await createModel(testEnv.DB, { publicModelId: modelId, sellPrices: { input: '1', output: '2' }, admissionMinBalanceUnits: '0', maxOutputTokens: 4096 }, context('model'));
  });

  it('stores three distinct upstream mappings without treating capabilities as converter availability', async () => {
    for (const protocol of ['chat', 'responses', 'messages'] as const) await createModelMapping(testEnv.DB, mapping(protocol), context(protocol));
    const rows = await listModelMappings(testEnv.DB, { publicModelId: modelId });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.upstreamModel).toBe(`provider-${row.protocol}`);
      expect(row.capabilities.protocol).toBe(row.protocol);
      expect(row.capabilities.features).toEqual([]);
      expect(row).not.toHaveProperty('supported');
      expect(row).not.toHaveProperty('converterReady');
    }
    expect((await listModelMappings(testEnv.DB, { publicModelId: modelId, protocol: 'responses' })).map((row) => row.upstreamModel)).toEqual(['provider-responses']);
    expect(await audits()).toHaveLength(3);
  });

  it('rejects duplicate tuple creation and missing parents without orphan audits', async () => {
    await createModelMapping(testEnv.DB, mapping(), context('first'));
    await expect(createModelMapping(testEnv.DB, mapping(), context('duplicate'))).rejects.toMatchObject({ code: 'conflict' });
    await expect(createModelMapping(testEnv.DB, { ...mapping('responses'), channelId: 'missing' }, context('missing'))).rejects.toMatchObject({ code: 'not_found' });
    await expect(createModelMapping(testEnv.DB, { ...mapping('messages'), publicModelId: 'missing' }, context('missing-model'))).rejects.toMatchObject({ code: 'not_found' });
    expect(await audits()).toHaveLength(1);
  });

  it('updates a single protocol via CAS and replaces capabilities without mutating input', async () => {
    await createModelMapping(testEnv.DB, mapping(), context('create-chat'));
    await createModelMapping(testEnv.DB, mapping('messages'), context('create-messages'));
    const capabilities = { protocol: 'chat' as const, features: ['tools' as const, 'parallel_tools' as const], maxOutputTokens: 4096 };
    const changed = await updateModelMapping(testEnv.DB, key(), 1, { upstreamModel: 'new-upstream', capabilities }, context('update'));
    capabilities.features.length = 0;
    expect(changed).toMatchObject({ configVersion: 2, upstreamModel: 'new-upstream' });
    expect(changed.capabilities.features).toEqual(['parallel_tools', 'tools']);
    expect((await getModelMapping(testEnv.DB, key('messages')))?.upstreamModel).toBe('provider-messages');
    await expect(updateModelMapping(testEnv.DB, key(), 1, { upstreamModel: 'stale' }, context('stale'))).rejects.toMatchObject({ code: 'conflict' });
    await expect(updateModelMapping(testEnv.DB, key(), 2, { protocol: 'messages' } as never, context('identity-change'))).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects unknown capability fields/features and contradictory declarations', async () => {
    for (const bad of [
      { protocol: 'messages', features: [] }, { protocol: 'chat', features: ['imaginary'] },
      { protocol: 'chat', features: ['tools', 'tools'] }, { protocol: 'chat', features: ['parallel_tools'] },
      { protocol: 'chat', features: ['stream_usage'] }, { protocol: 'chat', features: [], supported: true },
      { protocol: 'chat', features: [], converterReady: true }, { protocol: 'chat', features: [], maxOutputTokens: 0 },
      { protocol: 'chat', features: [], maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
      { protocol: 'chat', features: [], reasoningEfforts: ['high'] },
      { protocol: 'chat', features: ['cache_control'], cacheTtls: ['24h'] },
      { protocol: 'chat', features: [], nativeExtensions: [{ scope: 'request', name: 'authorization' }] },
      { protocol: 'chat', features: [], nativeExtensions: [{ scope: 'unknown', name: 'feature' }] },
    ]) {
      expect(() => validateMappingCapabilities(bad, 'chat')).toThrow();
      await expect(createModelMapping(testEnv.DB, { ...mapping(), capabilities: bad } as ModelMappingInput, context('invalid'))).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(await audits()).toEqual([]);
    expect(validateMappingCapabilities({ protocol: 'chat', features: ['reasoning_effort', 'cache_control'], reasoningEfforts: ['low', 'high'], cacheTtls: ['5m'], nativeExtensions: [{ scope: 'request', name: 'custom_option' }] }, 'chat')).toMatchObject({ reasoningEfforts: ['high', 'low'] });
  });

  it('filters active parents only when requested and rejects corrupt stored capability claims', async () => {
    await createModelMapping(testEnv.DB, mapping(), context('create'));
    await testEnv.DB.prepare('UPDATE channels SET status=? WHERE id=?').bind('disabled', channelId).run();
    expect(await listModelMappings(testEnv.DB, { publicModelId: modelId, activeOnly: true })).toEqual([]);
    expect(await listModelMappings(testEnv.DB, { publicModelId: modelId })).toHaveLength(1);
    await testEnv.DB.prepare('UPDATE channel_models SET capabilities_json=? WHERE channel_id=?').bind('{"protocol":"chat","features":[],"supported":true}', channelId).run();
    await expect(getModelMapping(testEnv.DB, key())).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('serializes concurrent updates with one audit and rolls back audit failures and zero-row mutations', async () => {
    await createModelMapping(testEnv.DB, mapping(), context('create'));
    const outcomes = await Promise.allSettled(['one', 'two'].map((name) => updateModelMapping(testEnv.DB, key(), 1, { upstreamModel: name }, context(name))));
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await audits()).toHaveLength(2);
    const before = await getModelMapping(testEnv.DB, key());
    await testEnv.DB.exec("CREATE TRIGGER c10_audit_fail BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'private failure'); END;");
    await expect(updateModelMapping(testEnv.DB, key(), 2, { upstreamModel: 'rolled-back' }, context('failed'))).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await getModelMapping(testEnv.DB, key())).toEqual(before);
    await testEnv.DB.exec('DROP TRIGGER c10_audit_fail;');
    await testEnv.DB.exec("CREATE TRIGGER c10_ignore_update BEFORE UPDATE ON channel_models BEGIN SELECT RAISE(IGNORE); END;");
    await expect(updateModelMapping(testEnv.DB, key(), 2, { upstreamModel: 'ignored' }, context('ignored'))).rejects.toMatchObject({ code: 'conflict' });
    expect(await getModelMapping(testEnv.DB, key())).toEqual(before);
    expect(await audits()).toHaveLength(2);
  });
});
