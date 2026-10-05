import { describe, expect, it } from 'vitest';
import { createMessagesPassthrough, messagesRequestAdapter, messagesResponseAdapter } from '../../../packages/apicompat/passthrough/messages.js';
import type { ResponseContext } from '../../../packages/apicompat/types/adapter.js';
import { extractMessagesUsage } from '../../../packages/apicompat/usage/messages.js';
import { createMessagesStreamSession } from '../../../packages/apicompat/passthrough/messages-stream.js';

const context: ResponseContext = { targetModel: 'public-model', identity: { responseId: 'msg_public' }, createdAt: 123,
  idFor() { throw new Error('Native block/tool identities must not be reallocated'); } };
const request = { model: 'public-model', max_tokens: 2048, messages: [{ role: 'user', content: 'Hello' }] };
const response = { id: 'msg_upstream', type: 'message', role: 'assistant', model: 'provider-model',
  content: [{ type: 'thinking', thinking: 'Native thinking', signature: 'opaque-signature' },
    { type: 'redacted_thinking', data: 'opaque-redacted-data' },
    { type: 'text', text: 'Hello', cache_control: { type: 'ephemeral', ttl: '1h' }, citations: null }],
  stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 7, output_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 4,
    cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 3 }, output_tokens_details: { thinking_tokens: 2 } } };

// Full official Message response field shape, fetched 2026-09-06. IDs/text are
// synthetic; counts are internally consistent and non-server-tool for this case.
// https://platform.claude.com/docs/en/api/messages/create
const officialMessage = { id: 'msg_official_fixture', type: 'message', role: 'assistant', model: 'claude-opus-5',
  container: { id: 'container_fixture', expires_at: '2026-09-06T00:00:00.000Z', skills: [{ skill_id: 'pdf', type: 'anthropic', version: 'latest' }] },
  content: [{ type: 'text', text: 'Synthetic reply.', citations: [] }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
  usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, output_tokens_details: { thinking_tokens: 0 },
    inference_geo: 'global', server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 }, service_tier: 'standard' } };

describe('official standard Messages JSON and SSE metadata', () => {
  it('retains the complete standard shape without altering usage or enabling container requests', () => {
    expect(messagesResponseAdapter.convert(officialMessage, context)).toMatchObject({ ok: true, value: {
      body: { ...officialMessage, id: context.identity.responseId, model: context.targetModel }, terminal: { status: 'completed', reason: 'stop' },
    } });
    const refusal = { ...officialMessage, stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } };
    expect(messagesResponseAdapter.convert(refusal, context)).toMatchObject({ ok: true, value: { body: { stop_details: refusal.stop_details }, terminal: { status: 'incomplete', reason: 'refusal' } } });
    expect(messagesRequestAdapter.convert({ ...request, container: officialMessage.container }, { targetModel: 'native' }).ok).toBe(true);
    expect(messagesResponseAdapter.convert({ ...officialMessage, unknown_echo: true }, context).ok).toBe(true);
  });
  it('preserves known server-tool counters as wire data, without claiming billable counts', () => {
    const toolUsage = { ...officialMessage.usage, server_tool_use: { web_fetch_requests: 2, web_search_requests: 1 } };
    const result = messagesResponseAdapter.convert({ ...officialMessage, usage: toolUsage }, context);
    expect(result).toMatchObject({ ok: true, value: { body: { usage: toolUsage } } });
    expect(result).not.toHaveProperty('counts');
    expect(messagesResponseAdapter.convert({ ...officialMessage, usage: { ...toolUsage, service_tier: {} } }, context).ok).toBe(false);
  });
  it('passes full message_start metadata and nullable stop_details through P20 terminal events', () => {
    const created = createMessagesStreamSession(context, { unknownEventPolicy: 'reject', maxBufferedBytes: 65536 });
    if (!created.ok) throw new Error('Invalid stream context');
    const events = [
      { type: 'message_start', message: { ...officialMessage, content: [], stop_reason: null, usage: { ...officialMessage.usage, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic reply.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null }, usage: officialMessage.usage },
      { type: 'message_stop' },
    ];
    for (const event of events) {
      const step = created.value.push({ event: event.type, data: JSON.stringify(event) });
      expect(step.events[0]?.event).toBe(event.type);
      if (event.type === 'message_start') expect(JSON.parse(step.events[0]!.data).message).toMatchObject({ container: officialMessage.container, usage: { service_tier: 'standard', inference_geo: 'global' } });
      if (event.type === 'message_delta') expect(JSON.parse(step.events[0]!.data).delta).toHaveProperty('stop_details', null);
      if (event.type === 'message_stop') expect(step.terminal).toMatchObject({ status: 'completed', reason: 'stop' });
    }
  });
});

describe('Messages same-protocol request JSON', () => {
  it('preserves native output_config without an extension bypass', () => {
    const input = { ...request, output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object', properties: { result: { type: 'string' } } } } } };
    const result = messagesRequestAdapter.convert(input, { targetModel: 'provider' });
    expect(result).toEqual({ ok: true, value: { ...input, model: 'provider' } });
    if (result.ok) expect(result.value.output_config).not.toBe(input.output_config);
  });
  it('preserves structured system, images, thinking, cache and parallel tool history; only model changes', () => {
    const input = { ...request, stream: true, system: [{ type: 'text', text: 'Rules', cache_control: { type: 'ephemeral', ttl: '5m' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Inspect' }, { type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' } }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'Reason', signature: 'keep-this' },
          { type: 'tool_use', id: 'tool_native_1', name: 'lookup', input: { password: 'user payload is not transport credentials' } },
          { type: 'tool_use', id: 'tool_native_2', name: 'lookup', input: { query: 'second' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_native_1', content: 'Result', is_error: false },
          { type: 'tool_result', tool_use_id: 'tool_native_2', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }] }] },
      ], tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { password: { type: 'string' } } }, strict: true,
        cache_control: { type: 'ephemeral', ttl: '1h' } }], tool_choice: { type: 'auto', disable_parallel_tool_use: false },
      thinking: { type: 'enabled', budget_tokens: 1024, display: 'summarized' }, cache_control: { type: 'ephemeral' },
      temperature: 0.5, top_p: 0.9, top_k: 10, stop_sequences: ['END'], metadata: { user_id: 'caller-owned' } };
    const before = structuredClone(input);
    const result = messagesRequestAdapter.convert(input, { targetModel: 'provider-model' });
    expect(result).toEqual({ ok: true, value: { ...input, model: 'provider-model' } });
    expect(input).toEqual(before);
    if (result.ok) expect(result.value.messages).not.toBe(input.messages);
  });

  it.each([
    { ...request, messages: [{ role: 'system', content: 'wrong location' }] },
  ])('rejects unsupported/malformed native features %#', input => {
    expect(messagesRequestAdapter.convert(input, { targetModel: 'u' }).ok).toBe(false);
  });
});

describe('Messages ordinary JSON response passthrough', () => {
  it('rewrites only root public ID/model, preserves native reasoning/cache data and does not change P14 usage evidence', () => {
    const before = structuredClone(response);
    const result = messagesResponseAdapter.convert(response, context);
    expect(result).toMatchObject({ ok: true, value: {
      body: { ...response, id: 'msg_public', model: 'public-model' },
      identity: { responseId: 'msg_public', upstreamResponseId: 'msg_upstream' }, terminal: { status: 'completed', reason: 'stop' },
    } });
    expect(response).toEqual(before);
    if (result.ok) {
      expect(result.value.body.content).not.toBe(response.content);
      expect(result.value.body.usage).not.toBe(response.usage);
      expect(extractMessagesUsage(result.value.body)).toEqual(extractMessagesUsage(response));
      expect(result.value.body).not.toHaveProperty('created_at');
      expect(result.value).not.toHaveProperty('counts');
    }
  });

  it('preserves parallel tool IDs and JSON inputs without converting arguments to strings', () => {
    const content = [{ type: 'tool_use', id: 'native-1', name: 'lookup', input: { n: 1 } },
      { type: 'tool_use', id: 'native-2', name: 'lookup', input: { n: 2 } }];
    expect(messagesResponseAdapter.convert({ ...response, content, stop_reason: 'tool_use' }, context))
      .toMatchObject({ ok: true, value: { body: { content, stop_reason: 'tool_use' }, terminal: { status: 'completed', reason: 'tool_calls' } } });
  });

  it.each([['max_tokens', 'length'], ['model_context_window_exceeded', 'length'], ['refusal', 'refusal'], ['pause_turn', 'unknown']])(
    'preserves %s but marks it incomplete as %s', (stop_reason, reason) => {
      expect(messagesResponseAdapter.convert({ ...response, stop_reason }, context))
        .toMatchObject({ ok: true, value: { body: { stop_reason }, terminal: { status: 'incomplete', reason } } });
    },
  );

  it('preserves stop-sequence and empty output without manufacturing text', () => {
    expect(messagesResponseAdapter.convert({ ...response, content: [], stop_reason: 'stop_sequence', stop_sequence: 'END' }, context))
      .toMatchObject({ ok: true, value: { body: { content: [], stop_sequence: 'END' }, terminal: { status: 'completed', reason: 'stop' } } });
  });

  it('keeps missing usage absent and nullable cache fields null, with no synthetic zeros', () => {
    const { usage: _usage, ...missing } = response;
    const result = messagesResponseAdapter.convert(missing, context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.body).not.toHaveProperty('usage');
      expect(extractMessagesUsage(result.value.body)).toMatchObject({ quality: 'missing' });
    }
    const usage = { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: null, cache_creation: null };
    expect(messagesResponseAdapter.convert({ ...response, usage }, context)).toMatchObject({ ok: true, value: { body: { usage } } });
  });

  it.each([
    { ...response, stop_reason: null },
    { ...response, usage: null }, { ...response, usage: { output_tokens: 0 } },
    { ...response, usage: { input_tokens: -1, output_tokens: 0 } },
    { ...response, role: 'user' }, { ...response, id: 'Bearer PRIVATE_TOKEN' },
    { type: 'message_start', message: response }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
  ])('rejects nonterminal, unsupported or malformed response %#', input => {
    expect(messagesResponseAdapter.convert(input, context).ok).toBe(false);
  });

  it('rejects invalid public model/identity and mismatched upstream identity', () => {
    expect(messagesResponseAdapter.convert(response, { ...context, identity: { responseId: 'public', upstreamResponseId: 'different' } }).ok).toBe(false);
    expect(messagesResponseAdapter.convert(response, { ...context, identity: { responseId: '' } }).ok).toBe(false);
    expect(messagesResponseAdapter.convert(response, { ...context, targetModel: 'bad\nmodel' }).ok).toBe(false);
    expect(messagesRequestAdapter.convert(request, { targetModel: '' }).ok).toBe(false);
  });
});
