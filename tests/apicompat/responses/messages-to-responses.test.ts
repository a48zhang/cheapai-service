/** SPDX-License-Identifier: LGPL-3.0-only
 * Original synthetic fixtures for the direct Messages -> Responses adapter.
 */
import { describe, expect, it } from 'vitest';
import { messagesToResponsesResponse, messagesToResponsesResponseAdapter } from '../../../packages/apicompat/responses/messages-to-responses.js';
import { createResponseIds } from '../../../packages/apicompat/ids.js';
import type { ResponseContext } from '../../../packages/apicompat/types/adapter.js';

const text = (value = 'Hello') => ({ type: 'text', text: value });
const basic = () => ({ id: 'msg_upstream', type: 'message', role: 'assistant', model: 'private-model', content: [text()], stop_reason: 'end_turn', stop_sequence: null });
function context(): ResponseContext {
  const ids = createResponseIds({ seed: 'mr_synthetic', upstreamResponseId: 'msg_upstream' });
  if (!ids.ok) throw new Error('Invalid fixture IDs');
  return { identity: ids.value.identity, idFor: ids.value.idFor, createdAt: 456, targetModel: 'public-model' };
}

describe('P-MR-J1 text, model and stable identity', () => {
  it('maps a normal Messages response directly to a Responses response', () => {
    const result = messagesToResponsesResponseAdapter.convert(basic(), context());
    expect(messagesToResponsesResponseAdapter.from).toBe('messages');
    expect(messagesToResponsesResponseAdapter.to).toBe('responses');
    if (!result.ok) throw new Error('Expected direct response');
    expect(result.value.body).toEqual({ id: 'resp_mr_synthetic', object: 'response', created_at: 456, model: 'public-model', status: 'completed', output: [{ type: 'message', id: 'item_mr_synthetic_0', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] }], incomplete_details: null });
    expect(result.value.identity).toEqual({ responseId: 'resp_mr_synthetic', upstreamResponseId: 'msg_upstream' });
    expect(result.value.terminal).toMatchObject({ status: 'completed', reason: 'stop' });
    expect(JSON.stringify(result.value.body)).not.toContain('private-model');
  });

  it('preserves multiple text blocks in order and does not invent output for empty content', () => {
    const source = { ...basic(), content: [text('First '), text('世界\n'), text('')] };
    const before = JSON.stringify(source);
    const result = messagesToResponsesResponse(source, context());
    if (!result.ok) throw new Error('Expected text conversion');
    expect(result.value.body.output).toEqual([{ type: 'message', id: 'item_mr_synthetic_0', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'First ', annotations: [] }, { type: 'output_text', text: '世界\n', annotations: [] }, { type: 'output_text', text: '', annotations: [] }] }]);
    expect(messagesToResponsesResponse(source, context())).toEqual(result);
    expect(JSON.stringify(source)).toBe(before);
    const empty = messagesToResponsesResponse({ ...basic(), content: [] }, context());
    if (!empty.ok) throw new Error('Expected empty response');
    expect(empty.value.body.output).toEqual([]);
  });

  it('accepts standard container and null stop metadata without forwarding diagnostics', () => {
    const source = { ...basic(), container: { id: 'container_one', expires_at: '2026-09-07T00:00:00Z', skills: [] }, stop_details: null };
    const result = messagesToResponsesResponse(source, context());
    if (!result.ok) throw new Error('Expected metadata conversion');
    expect(JSON.stringify(result.value.body)).not.toContain('container_one');
  });

  it.each([{ extra: 'unknown' }, { stop_reason: null }, { id: 'bad/id' }, { content: [{ type: 'redacted_thinking', data: 'private' }] }])('rejects nonordinary source case %#', (extra) => {
    expect(messagesToResponsesResponse({ ...basic(), ...extra }, context()).ok).toBe(false);
  });
});

const tool = (id = 'toolu_one', value: Record<string, unknown> = { city: '北京', nested: { values: [1, true, null] } }) => ({ type: 'tool_use', id, name: 'lookup', input: value });

describe('P-MR-J2 ordered text and tool output items', () => {
  it('preserves multiple tool IDs, arguments and text boundaries without a protocol pivot', () => {
    const source = { ...basic(), stop_reason: 'tool_use', content: [text('Before '), tool(), tool('toolu_two', {})] };
    const before = JSON.stringify(source);
    const result = messagesToResponsesResponse(source, context());
    if (!result.ok) throw new Error('Expected tool conversion');
    expect(result.value.body.output.map(item => item.type)).toEqual(['message', 'function_call', 'function_call']);
    expect(result.value.body.output[0]).toMatchObject({ content: [{ type: 'output_text', text: 'Before ' }] });
    expect(result.value.body.output[1]).toMatchObject({ type: 'function_call', call_id: 'toolu_one', name: 'lookup', arguments: JSON.stringify(tool().input) });
    expect(result.value.body.output[2]).toMatchObject({ type: 'function_call', call_id: 'toolu_two', arguments: '{}' });
    expect(new Set(result.value.body.output.map(item => item.id)).size).toBe(3);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('keeps tool-only output and explicit empty text as distinct Responses items', () => {
    const toolOnly = messagesToResponsesResponse({ ...basic(), stop_reason: 'tool_use', content: [tool()] }, context());
    const empty = messagesToResponsesResponse({ ...basic(), stop_reason: 'tool_use', content: [text(''), tool()] }, context());
    if (!toolOnly.ok || !empty.ok) throw new Error('Expected tool conversion');
    expect(toolOnly.value.body.output.map(item => item.type)).toEqual(['function_call']);
    expect(empty.value.body.output.map(item => item.type)).toEqual(['message', 'function_call']);
    expect(empty.value.body.output[0]).toMatchObject({ content: [{ type: 'output_text', text: '' }] });
  });

  it('preserves cross-kind output order and rejects invalid tool data', () => {
    const mixed = messagesToResponsesResponse({ ...basic(), stop_reason: 'tool_use', content: [tool(), text('after')] }, context());
    if (!mixed.ok) throw new Error('Expected representable mixed order');
    expect(mixed.value.body.output.map(item => item.type)).toEqual(['function_call', 'message']);
    for (const content of [[tool(), tool()], [{ ...tool(), input: [] }], [{ ...tool(), input: null }]]) {
      expect(messagesToResponsesResponse({ ...basic(), stop_reason: 'tool_use', content }, context()).ok).toBe(false);
    }
    expect(messagesToResponsesResponse({ ...basic(), stop_reason: 'tool_use', content: [{ ...tool(), id: 'bad/id' }] }, context()).ok).toBe(false);
    expect(messagesToResponsesResponse({ ...basic(), stop_reason: 'tool_use', content: [{ ...tool(), name: 'bad name' }] }, context()).ok).toBe(false);
  });
});

describe('P-MR-J3 native terminal semantics', () => {
  it('maps max_tokens to a Responses incomplete terminal and item status', () => {
    const result = messagesToResponsesResponse({ ...basic(), stop_reason: 'max_tokens', content: [text('partial')] }, context());
    if (!result.ok) throw new Error('Expected incomplete conversion');
    expect(result.value.body).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ status: 'incomplete' }] });
    expect(result.value.terminal).toMatchObject({ status: 'incomplete', reason: 'length' });
  });

  it('maps stop_sequence and tool_use without copying the stop marker into output', () => {
    const stop = messagesToResponsesResponse({ ...basic(), stop_reason: 'stop_sequence', stop_sequence: '<END>' }, context());
    if (!stop.ok) throw new Error('Expected stop-sequence conversion');
    expect(stop.value.body.status).toBe('completed');
    expect(JSON.stringify(stop.value.body)).not.toContain('<END>');
    const toolResult = messagesToResponsesResponse({ ...basic(), stop_reason: 'tool_use', content: [tool()] }, context());
    if (!toolResult.ok) throw new Error('Expected tool conversion');
    expect(toolResult.value.body.status).toBe('completed');
    expect(toolResult.value.terminal).toMatchObject({ status: 'completed', reason: 'tool_calls' });
  });

  it('rejects inconsistent tool and stop claims and missing tool payloads', () => {
    expect(messagesToResponsesResponse({ ...basic(), stop_reason: 'tool_use', content: [] }, context()).ok).toBe(false);
    expect(messagesToResponsesResponse({ ...basic(), stop_reason: 'end_turn', content: [tool()] }, context()).ok).toBe(false);
  });

  it.each(['pause_turn', null, 'vendor_unknown'])('never turns %s into normal Responses completion', (stop_reason) => {
    expect(messagesToResponsesResponse({ ...basic(), stop_reason }, context()).ok).toBe(false);
  });
});

describe('P-MR-J3-E standalone Messages errors', () => {
  it('returns a sanitized Responses error envelope and failed terminal', () => {
    const result = messagesToResponsesResponse({ type: 'error', request_id: 'private-request-id', error: { type: 'authentication_error', message: 'secret key at https://private.example', provider_debug: 'private-debug' } }, context());
    expect(result).toMatchObject({ ok: true, value: { body: { error: { type: 'server_error', code: 'upstream_error', param: null } }, terminal: { status: 'failed' } } });
    for (const secret of ['private-request-id', 'secret key', 'private.example', 'private-debug']) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([null, 'raw error', {}, { type: 'error', message: 1 }])('rejects malformed native error case %#', (error) => {
    expect(messagesToResponsesResponse({ type: 'error', error }, context()).ok).toBe(false);
  });

  it('rejects error/content mixtures', () => {
    expect(messagesToResponsesResponse({ type: 'error', error: { type: 'api_error', message: 'failed' }, content: [] }, context()).ok).toBe(false);
  });
});

const thought = (thinking = 'Consider the constraints.', signature = '') => ({ type: 'thinking', thinking, signature });

describe('P-MR-J3-T thinking and refusal content', () => {
  it('maps public thinking to Responses reasoning and keeps it out of answer text', () => {
    const result = messagesToResponsesResponse({ ...basic(), content: [thought(), text('Answer')] }, context());
    if (!result.ok) throw new Error('Expected thinking conversion');
    expect(result.value.body.output).toEqual([
      { type: 'reasoning', id: 'item_mr_synthetic_0', summary: [{ type: 'summary_text', text: 'Consider the constraints.' }], status: 'completed' },
      { type: 'message', id: 'item_mr_synthetic_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Answer', annotations: [] }] },
    ]);
    expect(JSON.stringify(result.value.body)).not.toContain('thinking');
  });

  it('keeps reasoning-only output as a reasoning item', () => {
    const result = messagesToResponsesResponse({ ...basic(), content: [thought()] }, context());
    if (!result.ok) throw new Error('Expected reasoning-only conversion');
    expect(result.value.body.output).toMatchObject([{ type: 'reasoning', summary: [{ text: 'Consider the constraints.' }] }]);
  });

  it.each([['opaque-signature', 'signature'], ['opaque-redaction', 'redacted_thinking'] as const])('rejects protected %s content without leaking it', (value, kind) => {
    const source = kind === 'signature' ? { ...basic(), content: [thought('public', value)] } : { ...basic(), content: [{ type: 'redacted_thinking', data: value }] };
    const result = messagesToResponsesResponse(source, context());
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it('maps refusal text to native Responses refusal content and terminal', () => {
    const result = messagesToResponsesResponse({ ...basic(), stop_reason: 'refusal', content: [text('Cannot comply.')] }, context());
    if (!result.ok) throw new Error('Expected refusal conversion');
    expect(result.value.body.output).toMatchObject([{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot comply.' }] }]);
    expect(result.value.body.status).toBe('completed');
    expect(result.value.terminal).toMatchObject({ status: 'incomplete', reason: 'refusal' });
    expect(messagesToResponsesResponse({ ...basic(), stop_reason: 'refusal', content: [] }, context()).ok).toBe(false);
  });

  it('rejects thinking after visible text rather than moving it before the answer', () => {
    expect(messagesToResponsesResponse({ ...basic(), content: [text('Answer'), thought()] }, context()).ok).toBe(false);
  });
});

describe('P-MR-J4 usage display without remeasurement', () => {
  it('converts Messages exclusive input plus cache buckets to Responses inclusive usage once', () => {
    const source = { ...basic(), usage: { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 4,
      cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 2 }, output_tokens_details: { thinking_tokens: 3 } } };
    const result = messagesToResponsesResponse(source, context());
    if (!result.ok) throw new Error('Expected usage conversion');
    expect(result.value.body.usage).toEqual({ input_tokens: 12, output_tokens: 7, total_tokens: 19, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } });
  });

  it('maps known no-cache counts and observed zeros without adding TTL tokens twice', () => {
    const result = messagesToResponsesResponse({ ...basic(), usage: { input_tokens: 4, output_tokens: 3 } }, context());
    if (!result.ok) throw new Error('Expected usage conversion');
    expect(result.value.body.usage).toEqual({ input_tokens: 4, output_tokens: 3, total_tokens: 7 });
    const zero = messagesToResponsesResponse({ ...basic(), usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: 0 } } }, context());
    if (!zero.ok) throw new Error('Expected zero usage conversion');
    expect(zero.value.body.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
  });

  it('keeps residual inclusive input and rejects unknown counters', () => {
    const ambiguous = messagesToResponsesResponse({ ...basic(), usage: { input_tokens: 4, output_tokens: 3, cache_read_input_tokens: 1 } }, context());
    if (!ambiguous.ok) throw new Error('Expected residual usage response');
    expect(ambiguous.value.body.usage).toEqual({ input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 1 } });
    for (const usage of [
      { input_tokens: 1, output_tokens: 1, cost_units: 2 },
      { input_tokens: 1, output_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: -1, ephemeral_1h_input_tokens: 0 } },
    ]) expect(messagesToResponsesResponse({ ...basic(), usage }, context()).ok).toBe(false);
  });
});
