/** SPDX-License-Identifier: LGPL-3.0-only
 * Original synthetic tests; pinned semantic references are documented in messages-to-chat.ts.
 * No upstream fixtures or runtime Responses pivot used.
 */
import { describe, expect, it } from 'vitest';
import { messagesToChatResponse, messagesToChatResponseAdapter } from '../../../packages/apicompat/responses/messages-to-chat.js';
import { createResponseIds } from '../../../packages/apicompat/ids.js';
import { parseChatResponse } from '../../../packages/apicompat/types/chat.js';
import type { ResponseContext } from '../../../packages/apicompat/types/adapter.js';
import { extractMessagesUsage } from '../../../packages/apicompat/usage/messages.js';
import { extractChatUsage } from '../../../packages/apicompat/usage/chat.js';

const text = (value = 'Hello') => ({ type: 'text', text: value });
const basic = () => ({ id: 'msg_upstream', type: 'message', role: 'assistant', model: 'private-model', content: [text()], stop_reason: 'end_turn', stop_sequence: null });
function context(): ResponseContext {
  const ids = createResponseIds({ seed: 'mc_synthetic', upstreamResponseId: 'msg_upstream' });
  if (!ids.ok) throw new Error('Invalid fixture identity');
  return { identity: ids.value.identity, idFor: ids.value.idFor, createdAt: 456, targetModel: 'public-model' };
}
describe('P-MC-J1 text and public response identity', () => {
  it('maps a normal message directly to a valid Chat completion', () => {
    const result = messagesToChatResponseAdapter.convert(basic(), context());
    expect(messagesToChatResponseAdapter.from).toBe('messages');
    expect(messagesToChatResponseAdapter.to).toBe('chat');
    if (!result.ok) throw new Error('Expected direct response');
    expect(result.value.body).toEqual({ id: 'resp_mc_synthetic', object: 'chat.completion', created: 456, model: 'public-model', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }] });
    expect(result.value.identity).toEqual({ responseId: 'resp_mc_synthetic', upstreamResponseId: 'msg_upstream' });
    expect(parseChatResponse(result.value.body).ok).toBe(true);
  });
  it('preserves multiple text blocks in order without inserting separators or rewriting JSON', () => {
    const source = { ...basic(), content: [text('First '), text('世界\n'), text('{"value":1}')] };
    const before = JSON.stringify(source); const ctx = context();
    const result = messagesToChatResponse(source, ctx);
    if (!result.ok) throw new Error('Expected text response');
    expect(result.value.body.choices[0]?.message.content).toBe('First 世界\n{"value":1}');
    expect(messagesToChatResponse(source, ctx)).toEqual(result);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('distinguishes empty text and empty content arrays', () => {
    const emptyText = messagesToChatResponse({ ...basic(), content: [text('')] }, context());
    const noText = messagesToChatResponse({ ...basic(), content: [] }, context());
    if (!emptyText.ok || !noText.ok) throw new Error('Expected empty content support');
    expect(emptyText.value.body.choices[0]?.message.content).toBe('');
    expect(noText.value.body.choices[0]?.message.content).toBeNull();
  });
  it('accepts absent/null/empty citation metadata but refuses actual unmapped citations', () => {
    for (const citations of [null, []]) expect(messagesToChatResponse({ ...basic(), content: [{ ...text(), citations }] }, context()).ok).toBe(true);
    expect(messagesToChatResponse({ ...basic(), content: [{ ...text(), citations: [{ type: 'char_location', document_title: 'reference' }] }] }, context()).ok).toBe(false);
  });
  it.each([{ extra: 'unknown' }])('rejects not-yet-implemented fields case %#', (extra) => {
    expect(messagesToChatResponse({ ...basic(), ...extra }, context()).ok).toBe(false);
  });
  it('rejects unknown blocks and invalid public context without leaking provider details', () => {
    expect(messagesToChatResponse({ ...basic(), content: [{ type: 'server_tool_use', secret: 'hidden' }] }, context()).ok).toBe(false);
    expect(messagesToChatResponse(basic(), { ...context(), targetModel: '' }).ok).toBe(false);
    expect(messagesToChatResponse(basic(), { ...context(), identity: { responseId: 'invalid/id' } }).ok).toBe(false);
  });
});

describe('P-MC-J4 original Messages usage display', () => {
  it('includes each cache bucket once and retains TTL subdivisions only as metadata', () => {
    const source = { ...basic(), usage: { input_tokens: 4, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
      cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 2 }, output_tokens_details: { thinking_tokens: 2 } } };
    const before = JSON.stringify(source); const ctx = context();
    const result = messagesToChatResponse(source, ctx);
    if (!result.ok) throw new Error('Expected usage display');
    expect(result.value.body.usage).toEqual({ prompt_tokens: 11, completion_tokens: 5, total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 4, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 2 } }, completion_tokens_details: { reasoning_tokens: 2 } });
    // P12 comparison is test-only; P14 remains the original accounting source.
    const display = extractChatUsage(result.value.body);
    if (display.quality !== 'complete') throw new Error('Expected complete displayed counters');
    expect(display.counts.inputTokens).toBe(11);
    expect(display.counts.outputTokens).toBe(5);
    expect(extractMessagesUsage(source).quality).toBe('complete');
    expect(messagesToChatResponse(source, ctx)).toEqual(result);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('accepts common neutral tier/geo/zero-server-tool metadata and real zero counters', () => {
    const result = messagesToChatResponse({ ...basic(), container: null, stop_details: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        service_tier: 'standard', inference_geo: 'global', server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 } } }, context());
    if (!result.ok) throw new Error('Expected standard Messages envelope');
    expect(result.value.body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } });
  });
  it('does not label cache-exclusive native input as an inclusive prompt when cache counts are missing', () => {
    const result = messagesToChatResponse({ ...basic(), usage: { input_tokens: 4, output_tokens: 5 } }, context());
    if (!result.ok) throw new Error('Expected answer with partial usage');
    expect(result.value.body.usage).toEqual({ completion_tokens: 5 });
    expect(extractChatUsage(result.value.body).quality).toBe('partial');
  });
  it('keeps only observed cache details in partial evidence rather than filling null with zero', () => {
    const result = messagesToChatResponse({ ...basic(), usage: { input_tokens: 4, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: 2 } }, context());
    if (!result.ok) throw new Error('Expected partial cache evidence');
    expect(result.value.body.usage).toEqual({ completion_tokens: 5, prompt_tokens_details: { cache_write_tokens: 2 } });
  });
  it('does not advertise exact token usage when nonzero server tools are unpriced', () => {
    const source = { ...basic(), usage: { input_tokens: 4, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 1 } } };
    expect(extractMessagesUsage(source).quality).toBe('invalid');
    const result = messagesToChatResponse(source, context());
    if (!result.ok) throw new Error('Expected visible answer with unknown usage');
    expect(Object.hasOwn(result.value.body, 'usage')).toBe(false);
  });
  it('does not turn contradictory TTL totals or missing usage into exact zero', () => {
    const source = { ...basic(), usage: { input_tokens: 4, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 1,
      cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 1 } } };
    const result = messagesToChatResponse(source, context());
    if (!result.ok) throw new Error('Expected answer without exact usage');
    expect(Object.hasOwn(result.value.body, 'usage')).toBe(false);
    const absent = messagesToChatResponse(basic(), context());
    if (!absent.ok) throw new Error('Expected absent usage');
    expect(Object.hasOwn(absent.value.body, 'usage')).toBe(false);
  });
  it('rejects unknown usage counters and malformed scalar counts', () => {
    for (const usage of [{ input_tokens: -1, output_tokens: 5 }, { input_tokens: 4, output_tokens: 5, price: 99 }, { input_tokens: 4, output_tokens: 5, output_tokens_details: { thinking_tokens: 1, private_counter: 1 } }]) {
      expect(messagesToChatResponse({ ...basic(), usage }, context()).ok).toBe(false);
    }
  });
});

const thought = (thinking = 'Consider ', signature = '') => ({ type: 'thinking', thinking, signature });
describe('P-MC-J3-T public thinking versus protected payloads', () => {
  it('preserves unsigned thinking prefixes, text and tools in representable order', () => {
    const source = { ...basic(), stop_reason: 'tool_use', content: [thought(), thought('constraints.'), text('Calling '), text('lookup.'), tool()] };
    const result = messagesToChatResponse(source, context());
    if (!result.ok) throw new Error('Expected unsigned compatible thinking');
    expect(result.value.body.choices[0]?.message).toMatchObject({ reasoning_content: 'Consider constraints.', content: 'Calling lookup.', tool_calls: [{ id: 'toolu_one' }] });
  });
  it('does not downgrade thinking-only output into visible answer text', () => {
    const result = messagesToChatResponse({ ...basic(), content: [thought()] }, context());
    if (!result.ok) throw new Error('Expected reasoning-only output');
    expect(result.value.body.choices[0]?.message).toMatchObject({ content: null, reasoning_content: 'Consider ' });
  });
  it.each([[thought('private thought', 'opaque-signature')], [{ type: 'redacted_thinking', data: 'opaque-redaction' }]])('does not fabricate or discard protected payload case %#', (content) => {
    const result = messagesToChatResponse({ ...basic(), content }, context());
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('opaque-');
  });
  it('rejects thinking after visible content and preserves incomplete reasoning terminals', () => {
    expect(messagesToChatResponse({ ...basic(), content: [text('answer'), thought()] }, context()).ok).toBe(false);
    const result = messagesToChatResponse({ ...basic(), stop_reason: 'max_tokens', content: [thought()] }, context());
    if (!result.ok) throw new Error('Expected incomplete public thinking');
    expect(result.value.body.choices[0]).toMatchObject({ finish_reason: 'length', message: { reasoning_content: 'Consider ', content: null } });
  });
});

describe('P-MC-J3-E native Messages errors', () => {
  it('uses a target-native public error and failed terminal without leaking raw diagnostics', () => {
    const result = messagesToChatResponse({ type: 'error', request_id: 'private-request-id', error: { type: 'authentication_error', message: 'secret key at https://private.example', provider_debug: 'private-debug' } }, context());
    expect(result).toMatchObject({ ok: true, value: { body: { error: { type: 'server_error', code: 'upstream_error', param: null } }, terminal: { status: 'failed' } } });
    for (const secret of ['private-request-id', 'secret key', 'private.example', 'private-debug']) expect(JSON.stringify(result)).not.toContain(secret);
  });
  it.each([null, 'raw', {}, { type: 'error', message: 1 }])('rejects malformed error case %#', (error) => {
    expect(messagesToChatResponse({ type: 'error', error }, context()).ok).toBe(false);
  });
  it('rejects error/content ambiguity and never calls a message accessor', () => {
    expect(messagesToChatResponse({ type: 'error', error: { type: 'api_error', message: 'failed' }, content: [text()] }, context()).ok).toBe(false);
    let called = false;
    expect(messagesToChatResponse({ type: 'error', error: { type: 'api_error', get message() { called = true; throw new Error('private'); } } }, context()).ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('P-MC-J3 real native stopping semantics', () => {
  it.each(['max_tokens', 'model_context_window_exceeded'])('maps %s to length without claiming normal completion', (stop_reason) => {
    const result = messagesToChatResponse({ ...basic(), stop_reason }, context());
    if (!result.ok) throw new Error('Expected truncated response');
    expect(result.value.body.choices[0]?.finish_reason).toBe('length');
    expect(result.value.terminal).toMatchObject({ status: 'incomplete', reason: 'length' });
  });
  it('maps an actual matched stop sequence without appending it to output', () => {
    const result = messagesToChatResponse({ ...basic(), stop_reason: 'stop_sequence', stop_sequence: '<END>' }, context());
    if (!result.ok) throw new Error('Expected stop-sequence mapping');
    expect(result.value.body.choices[0]).toMatchObject({ finish_reason: 'stop', message: { content: 'Hello' } });
    expect(result.value.terminal).toMatchObject({ upstreamReason: 'stop_sequence' });
    expect(JSON.stringify(result.value.body)).not.toContain('<END>');
  });
  it('keeps refusal text separate from normal content and refuses missing payloads', () => {
    const result = messagesToChatResponse({ ...basic(), stop_reason: 'refusal', content: [text('Cannot '), text('comply.')] }, context());
    if (!result.ok) throw new Error('Expected refusal');
    expect(result.value.body.choices[0]).toMatchObject({ finish_reason: 'stop', message: { content: null, refusal: 'Cannot comply.' } });
    expect(result.value.terminal).toMatchObject({ status: 'incomplete', reason: 'refusal' });
    expect(messagesToChatResponse({ ...basic(), stop_reason: 'refusal', content: [] }, context()).ok).toBe(false);
  });
  it.each(['pause_turn', null, 'vendor_error', 'content_filter'])('never turns unrepresentable stop case %# into success', (stop_reason) => {
    expect(messagesToChatResponse({ ...basic(), stop_reason }, context()).ok).toBe(false);
  });
  it('keeps interrupted tools under length and rejects inconsistent tool/end-turn claims', () => {
    const result = messagesToChatResponse({ ...basic(), stop_reason: 'max_tokens', content: [tool()] }, context());
    if (!result.ok) throw new Error('Expected incomplete tools');
    expect(result.value.body.choices[0]?.finish_reason).toBe('length');
    expect(messagesToChatResponse({ ...basic(), content: [tool()] }, context()).ok).toBe(false);
  });
  it('accepts standard container/null metadata without treating diagnostics as assistant text', () => {
    expect(messagesToChatResponse({ ...basic(), container: null, stop_details: null }, context()).ok).toBe(true);
    expect(messagesToChatResponse({ ...basic(), container: { id: 'container_one', expires_at: '2026-09-07T00:00:00Z', skills: [] } }, context()).ok).toBe(true);
    const result = messagesToChatResponse({ ...basic(), stop_reason: 'refusal', content: [text('Cannot comply.')], stop_details: { type: 'refusal', category: 'policy', explanation: 'private diagnostic', recommended_model: 'private-model' } }, context());
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
  });
});

const tool = (id = 'toolu_one', value: Record<string, unknown> = { city: '北京', nested: { values: [1, true, null] } }) => ({ type: 'tool_use', id, name: 'lookup', input: value });
describe('P-MC-J2 multiple text/tool blocks', () => {
  it('keeps ordinary text runs and multi-tool IDs/parameters in order', () => {
    const source = { ...basic(), stop_reason: 'tool_use', content: [text('First '), text('second'), tool(), tool('toolu_two', {})] };
    const before = JSON.stringify(source);
    const result = messagesToChatResponse(source, context());
    if (!result.ok) throw new Error('Expected direct tools');
    expect(result.value.body.choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { content: 'First second', tool_calls: [{ id: 'toolu_one', type: 'function', function: { name: 'lookup' } }, { id: 'toolu_two', function: { arguments: '{}' } }] } });
    expect(JSON.parse(result.value.body.choices[0]!.message.tool_calls![0]!.function.arguments)).toEqual(tool().input);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('preserves tool-only null versus explicit empty text', () => {
    for (const [content, expected] of [[[tool()], null], [[text(''), tool()], '']] as const) {
      const result = messagesToChatResponse({ ...basic(), stop_reason: 'tool_use', content }, context());
      if (!result.ok) throw new Error('Expected tools');
      expect(result.value.body.choices[0]?.message.content).toBe(expected);
    }
  });
  it('rejects real cross-kind interleaving instead of moving later text before tools', () => {
    expect(messagesToChatResponse({ ...basic(), stop_reason: 'tool_use', content: [tool(), text('after execution request')] }, context()).ok).toBe(false);
  });
  it('rejects duplicate IDs, invalid input objects and unsafe numeric IDs rather than fabricating arguments', () => {
    for (const content of [[tool(), tool()], [{ ...tool(), input: [] }], [{ ...tool(), input: null }], [tool('toolu_one', { id: Number.MAX_SAFE_INTEGER + 1 })]]) {
      expect(messagesToChatResponse({ ...basic(), stop_reason: 'tool_use', content }, context()).ok).toBe(false);
    }
    expect(messagesToChatResponse({ ...basic(), stop_reason: 'tool_use', content: [] }, context())).toMatchObject({ ok: false, error: { code: 'missing_tool_use' } });
  });
});
