/**
 * P23 local support evidence. These are synthetic protocol bodies/events and
 * actual default-registry adapter calls; they are not provider recordings.
 */
import { describe, expect, it } from 'vitest';
import { defaultProtocolRegistry } from '../../packages/apicompat/index.js';
import type { RegistryFactoryContext } from '../../packages/apicompat/index.js';
import type { ChannelCapabilities } from '../../packages/apicompat/capabilities/check.js';
import type { Protocol, SseFrame } from '../../packages/apicompat/types/shared.js';

const protocols = ['chat', 'responses', 'messages'] as const satisfies readonly Protocol[];
type P = (typeof protocols)[number];

const basicRequests: Record<P, unknown> = {
  chat: { model: 'public-model', messages: [{ role: 'user', content: 'Synthetic prompt' }] },
  responses: { model: 'public-model', input: 'Synthetic prompt' },
  messages: { model: 'public-model', max_tokens: 16, messages: [{ role: 'user', content: 'Synthetic prompt' }] },
};
const basicResponses: Record<P, unknown> = {
  chat: { id: 'native_chat', object: 'chat.completion', created: 123, model: 'provider-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
  responses: { id: 'native_responses', object: 'response', created_at: 123, model: 'provider-responses', status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
  messages: { id: 'native_messages', type: 'message', role: 'assistant', model: 'provider-messages', content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
};
function channel(protocol: P): ChannelCapabilities {
  return { protocol, features: ['streaming'], maxOutputTokens: 64, ...(protocol === 'messages' ? { defaultOutputTokens: 16 } : {}), reasoningEfforts: ['low', 'medium', 'high'], cacheTtls: ['5m', '1h'] };
}
function factoryContext(protocol: P): RegistryFactoryContext {
  return { capabilities: channel(protocol), outputTokenLimit: 16 };
}
function responseContext(upstreamResponseId: string) {
  return {
    identity: { responseId: 'public_response', upstreamResponseId }, targetModel: 'public-model', createdAt: 456,
    idFor(kind: 'item' | 'tool_call', key: string) { return `${kind}_${key.replace(/[^A-Za-z0-9_-]/g, '_')}`; },
  };
}
function frame(value: unknown, event?: string): SseFrame { return { data: JSON.stringify(value), ...(event === undefined ? {} : { event }) }; }
function sourceFrames(protocol: P): readonly SseFrame[] {
  if (protocol === 'chat') {
    const base = { id: 'native_chat', object: 'chat.completion.chunk', model: 'provider-chat', created: 123 };
    return [frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }] }),
      frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      frame({ ...base, choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }), { data: '[DONE]' }];
  }
  if (protocol === 'responses') {
    return [frame({ type: 'response.created', sequence_number: 0, response: { ...basicResponses.responses, status: 'in_progress', usage: null } }, 'response.created'),
      frame({ type: 'response.completed', sequence_number: 1, response: basicResponses.responses }, 'response.completed')];
  }
  return [
    frame({ type: 'message_start', message: { ...basicResponses.messages, content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }, 'message_start'),
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start'),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }, 'content_block_delta'),
    frame({ type: 'content_block_stop', index: 0 }, 'content_block_stop'),
    frame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }, 'message_delta'),
    frame({ type: 'message_stop' }, 'message_stop'),
  ];
}

// Basic JSON/SSE registry wiring is covered in registry.test.ts; tool round trips
// for all nine directions live in tests/gateway/matrix with billing assertions.
describe('P23 field boundary and usage evidence', () => {
  it('does not broaden a cross-protocol request with unknown fields', () => {
    const found = defaultProtocolRegistry.lookup({ from: 'chat', to: 'responses', streaming: false }, factoryContext('responses'));
    if (!found.ok) throw new Error('Missing Chat->Responses');
    expect(found.value.request.convert({ ...basicRequests.chat as object, private_field: 'secret' } as never, { targetModel: 'provider-model' }).ok).toBe(false);
  });

  it('rejects private signed/encrypted thinking through actual cross-protocol response adapters', () => {
    const encrypted = { ...(basicResponses.responses as object), output: [{ type: 'reasoning', id: 'reasoning_private', summary: [{ type: 'summary_text', text: 'public summary' }], encrypted_content: 'opaque-signature', status: 'completed' }] };
    const rm = defaultProtocolRegistry.lookup({ from: 'messages', to: 'responses', streaming: false }, factoryContext('responses'));
    if (!rm.ok) throw new Error('Missing Responses->Messages');
    const rejectedRm = rm.value.response.convert(encrypted as never, responseContext('native_responses'));
    expect(rejectedRm.ok).toBe(false);
    expect(JSON.stringify(rejectedRm)).not.toContain('opaque-signature');

    const signed = { ...(basicResponses.messages as object), content: [{ type: 'thinking', thinking: 'public summary', signature: 'opaque-signature' }] };
    const mr = defaultProtocolRegistry.lookup({ from: 'responses', to: 'messages', streaming: false }, factoryContext('messages'));
    if (!mr.ok) throw new Error('Missing Messages->Responses');
    const rejectedMr = mr.value.response.convert(signed as never, responseContext('native_messages'));
    expect(rejectedMr.ok).toBe(false);
    expect(JSON.stringify(rejectedMr)).not.toContain('opaque-signature');
  });

  it('accepts standard metadata and annotations:[] without treating them as private output', () => {
    const source = { ...(basicResponses.responses as object), service_tier: 'default', metadata: { trace: 'fixture' }, output: [{ type: 'message', id: 'msg_standard', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hi', annotations: [] }] }] };
    const found = defaultProtocolRegistry.lookup({ from: 'chat', to: 'responses', streaming: false }, factoryContext('responses'));
    if (!found.ok) throw new Error('Missing Chat->Responses');
    expect(found.value.response.convert(source as never, responseContext('native_responses')).ok).toBe(true);
  });

  it('keeps Messages initial usage placeholders wire-only on target streams', () => {
    const cases: readonly { from: P; to: P; source: SseFrame }[] = [
      { from: 'messages', to: 'chat', source: sourceFrames('chat')[0]! },
      { from: 'messages', to: 'responses', source: sourceFrames('responses')[0]! },
    ];
    for (const { from, to, source } of cases) {
      const found = defaultProtocolRegistry.lookup({ from, to, streaming: true }, factoryContext(to));
      if (!found.ok) throw new Error(`Missing ${from}->${to}`);
      const created = found.value.stream.create(responseContext((sourceFrames(to)[0]!.data.match(/native_[a-z]+/) ?? ['native'])[0]), { unknownEventPolicy: 'reject', maxBufferedBytes: 32_768 });
      if (!created.ok) throw new Error('Missing stream session');
      const first = created.value.push(source);
      const start = first.events.find(event => event.event === 'message_start');
      if (!start) throw new Error(`Expected Messages start for ${from}->${to}`);
      const parsed = JSON.parse(start.data) as { message: { usage?: unknown } };
      expect(parsed.message.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    }
  });

  it('separates residual target display from the original source usage snapshot', () => {
    const source = { ...(basicResponses.chat as object), usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 5 } } };
    const found = defaultProtocolRegistry.lookup({ from: 'messages', to: 'chat', streaming: false }, factoryContext('chat'));
    if (!found.ok) throw new Error('Missing Chat->Messages response adapter');
    const converted = found.value.response.convert(source as never, responseContext('native_chat'));
    if (!converted.ok) throw new Error('Expected residual conversion');
    expect(converted.value.body).toMatchObject({ usage: { input_tokens: 7, output_tokens: 7, cache_read_input_tokens: 5 } });
    expect(found.value.usage.json(source)).toMatchObject({ quality: 'complete', counts: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 5 } });
    expect(JSON.stringify(source)).toContain('"prompt_tokens":12');
  });
});
