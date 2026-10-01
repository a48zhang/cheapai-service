/**
 * P23 local support evidence. These are synthetic protocol bodies/events and
 * actual default-registry adapter calls; they are not provider recordings.
 */
import { describe, expect, it } from 'vitest';
import { createProtocolRegistry, defaultProtocolRegistry } from '../../packages/apicompat/index.js';
import type { RegistryFactoryContext, RegistryDirection } from '../../packages/apicompat/index.js';
import type { CapabilityFeature, ChannelCapabilities } from '../../packages/apicompat/capabilities/check.js';
import type { Protocol, SseFrame } from '../../packages/apicompat/types/shared.js';

const protocols = ['chat', 'responses', 'messages'] as const satisfies readonly Protocol[];
type P = (typeof protocols)[number];
const pairs = protocols.flatMap(from => protocols.map(to => ({ from, to }))) as readonly { from: P; to: P }[];
const pairRows = pairs.map(({ from, to }) => [from, to] as const);

const allFeatures: readonly CapabilityFeature[] = [
  'streaming', 'stream_usage', 'tools', 'tool_choice', 'parallel_tools', 'parallel_tool_control', 'strict_tools',
  'image_url', 'image_base64', 'image_file_id', 'image_detail', 'tool_result_images', 'tool_result_error', 'refusal_history',
  'json_object', 'json_schema', 'reasoning_effort', 'reasoning_summary', 'reasoning_history', 'thinking_budget',
  'thinking_adaptive', 'thinking_control', 'signed_thinking', 'redacted_thinking', 'encrypted_reasoning', 'cache_control',
  'response_history', 'item_references', 'file_inputs', 'file_references', 'temperature', 'top_p', 'top_k',
  'stop_sequences', 'seed', 'penalties', 'multiple_choices', 'service_tier', 'metadata', 'message_names', 'store',
  'verbosity', 'citations', 'logprobs', 'system_developer_priority',
];

const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } as const;
const basicRequests: Record<P, unknown> = {
  chat: { model: 'public-model', messages: [{ role: 'user', content: 'Synthetic prompt' }] },
  responses: { model: 'public-model', input: 'Synthetic prompt' },
  messages: { model: 'public-model', max_tokens: 16, messages: [{ role: 'user', content: 'Synthetic prompt' }] },
};
const toolRequests: Record<P, unknown> = {
  chat: { model: 'public-model', messages: [{ role: 'user', content: 'Use lookup' }], tools: [{ type: 'function', function: { name: 'lookup', parameters: schema } }], tool_choice: 'auto' },
  responses: { model: 'public-model', input: 'Use lookup', tools: [{ type: 'function', name: 'lookup', parameters: schema, strict: false }], tool_choice: 'auto' },
  messages: { model: 'public-model', max_tokens: 16, messages: [{ role: 'user', content: 'Use lookup' }], tools: [{ name: 'lookup', input_schema: schema }], tool_choice: { type: 'auto' } },
};

const basicResponses: Record<P, unknown> = {
  chat: { id: 'native_chat', object: 'chat.completion', created: 123, model: 'provider-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
  responses: { id: 'native_responses', object: 'response', created_at: 123, model: 'provider-responses', status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
  messages: { id: 'native_messages', type: 'message', role: 'assistant', model: 'provider-messages', content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
};
const toolResponses: Record<P, unknown> = {
  chat: { id: 'native_chat', object: 'chat.completion', created: 123, model: 'provider-chat', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{"city":"北京"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
  responses: { id: 'native_responses', object: 'response', created_at: 123, model: 'provider-responses', status: 'completed', output: [{ type: 'function_call', id: 'item_lookup', call_id: 'call_lookup', name: 'lookup', arguments: '{"city":"北京"}', status: 'completed' }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
  messages: { id: 'native_messages', type: 'message', role: 'assistant', model: 'provider-messages', content: [{ type: 'tool_use', id: 'call_lookup', name: 'lookup', input: { city: '北京' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
};

function channel(protocol: P, rich = false): ChannelCapabilities {
  return { protocol, features: rich ? allFeatures : ['streaming'], maxOutputTokens: 64, ...(protocol === 'messages' ? { defaultOutputTokens: 16 } : {}), reasoningEfforts: ['low', 'medium', 'high'], cacheTtls: ['5m', '1h'] };
}
function factoryContext(protocol: P, rich = false): RegistryFactoryContext {
  return { capabilities: channel(protocol, rich), outputTokenLimit: 16 };
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

describe('P23 default registry covers all nine direct directions', () => {
  it('declares exactly nine directions and makes both modes available', () => {
    expect(defaultProtocolRegistry.directions).toEqual(pairs);
    for (const { from, to } of pairs) for (const streaming of [false, true]) {
      expect(defaultProtocolRegistry.available({ from, to, streaming })).toBe(true);
      expect(defaultProtocolRegistry.lookup({ from, to, streaming }, factoryContext(to)).ok).toBe(true);
    }
  });

  it.each(pairRows)('%s -> %s calls the actual JSON request and response adapters', (from, to) => {
    const direction: RegistryDirection<P, P> = { from, to, streaming: false };
    const found = defaultProtocolRegistry.lookup(direction, factoryContext(to));
    if (!found.ok) throw new Error(`Missing ${from}->${to}`);
    expect(found.value.request).toMatchObject({ from, to });
    expect(found.value.response).toMatchObject({ from: to, to: from });
    const request = found.value.request.convert(basicRequests[from] as never, { targetModel: 'provider-model' });
    expect(request.ok).toBe(true);
    const source = basicResponses[to];
    const response = found.value.response.convert(source as never, responseContext((source as { id: string }).id));
    expect(response.ok).toBe(true);
  });

  it.each(pairRows)('%s -> %s calls actual tool request/response adapters', (from, to) => {
    const found = defaultProtocolRegistry.lookup({ from, to, streaming: false }, factoryContext(to, true));
    if (!found.ok) throw new Error(`Missing ${from}->${to}`);
    expect(found.value.request.convert(toolRequests[from] as never, { targetModel: 'provider-model' }).ok).toBe(true);
    const source = toolResponses[to];
    expect(found.value.response.convert(source as never, responseContext((source as { id: string }).id)).ok).toBe(true);
  });

  it.each(pairRows)('%s -> %s calls the actual SSE adapter', (from, to) => {
    const found = defaultProtocolRegistry.lookup({ from, to, streaming: true }, factoryContext(to));
    if (!found.ok) throw new Error(`Missing ${from}->${to}`);
    const source = basicResponses[to] as { id: string };
    const stream = found.value.stream.create(responseContext(source.id), { unknownEventPolicy: 'reject', maxBufferedBytes: 32_768 });
    if (!stream.ok) throw new Error(`Cannot create ${to}->${from} stream`);
    let terminal: import('../../packages/apicompat/types/shared.js').TerminalState | undefined;
    for (const input of sourceFrames(to)) {
      const step = stream.value.push(input);
      terminal ??= step.terminal;
    }
    terminal ??= stream.value.finish({ kind: 'eof' }).terminal;
    expect(terminal?.status).toBe('completed');
    expect(stream.value.finish({ kind: 'eof' }).events).toEqual([]);
  });
});

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

describe('P23 registry construction remains explicit', () => {
  it('retains the real production registry and preserves injectable test registries', () => {
    expect(createProtocolRegistry().directions).toEqual(defaultProtocolRegistry.directions);
  });
});
