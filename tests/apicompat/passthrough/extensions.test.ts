import { describe, expect, it } from 'vitest';
import { defaultProtocolRegistry } from '../../../packages/apicompat';
import type { Protocol } from '../../../packages/apicompat/types/shared';

const requests = {
  chat: { model: 'm', messages: [{ role: 'user', content: [{ type: 'input_audio', audio: 'opaque' }] }], tools: [{ type: 'vendor_tool' }] },
  messages: { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'http://docs.local/file' } }] }], tools: [{ type: 'web_search_20250305', name: 'search' }] },
  responses: { model: 'm', input: [{ type: 'computer_call', custom: true }], tools: [{ type: 'web_search' }] },
};

describe('native provider extensions', () => {
  it.each(['chat', 'messages', 'responses'] as const)('preserves %s unknown fields and provider-native content/tool variants without declarations', protocol => {
    const registry = defaultProtocolRegistry.lookup({ from: protocol, to: protocol, streaming: false }, { capabilities: { protocol, features: [] } });
    if (!registry.ok) throw new Error('Missing native adapter');
    const input = { ...requests[protocol], provider: { headers: { token: 'application data' } } };
    expect(registry.value.request.convert(input, { targetModel: 'provider-model' })).toEqual({ ok: true, value: { ...input, model: 'provider-model' } });
  });
  it.each(['chat', 'messages', 'responses'] as const)('preserves an unknown %s stream event without inventing completion or usage', protocol => {
    const registry = defaultProtocolRegistry.lookup({ from: protocol, to: protocol, streaming: true }, { capabilities: { protocol, features: [] } });
    if (!registry.ok) throw new Error('Missing native adapter');
    const session = registry.value.stream.create({ identity: { responseId: 'public' }, targetModel: 'm', createdAt: 0, idFor: () => 'item' }, { unknownEventPolicy: 'preserve', maxBufferedBytes: 4096 });
    if (!session.ok) throw new Error('Missing stream session');
    const frame = { event: 'provider.progress', data: JSON.stringify({ type: 'provider.progress', opaque: true }) };
    expect(session.value.push(frame)).toEqual({ events: [frame], usageUpdates: [] });
    expect(session.value.finish({ kind: 'eof' }).terminal?.status).not.toBe('completed');
  });
  it.each(['messages', 'responses'] as const)('rejects unknown chat content when translating to %s instead of silently dropping it', protocol => {
    const registry = defaultProtocolRegistry.lookup({ from: 'chat', to: protocol as Protocol, streaming: false }, { capabilities: { protocol, features: [] }, outputTokenLimit: 64 });
    if (!registry.ok) throw new Error('Missing cross adapter');
    expect(registry.value.request.convert(requests.chat, { targetModel: 'm' }).ok).toBe(false);
  });
});
