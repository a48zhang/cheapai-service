/** SPDX-License-Identifier: LGPL-3.0-only
 * Original synthetic fixtures for the direct Responses -> Messages adapter.
 */
import { describe, expect, it } from 'vitest';
import { responsesToMessagesResponse, responsesToMessagesResponseAdapter } from '../../../packages/apicompat/responses/responses-to-messages.js';
import { createResponseIds } from '../../../packages/apicompat/ids.js';
import { parseMessagesResponse } from '../../../packages/apicompat/types/messages.js';
import type { ResponseContext } from '../../../packages/apicompat/types/adapter.js';

const message = (id = 'msg_one', text = 'Hello') => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const basic = () => ({ id: 'resp_upstream', object: 'response', created_at: 123, model: 'private-model', status: 'completed', output: [message()], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } });
function context(): ResponseContext {
  const ids = createResponseIds({ seed: 'rm_synthetic', upstreamResponseId: 'resp_upstream' });
  if (!ids.ok) throw new Error('Invalid fixture IDs');
  return { identity: ids.value.identity, idFor: ids.value.idFor, createdAt: 456, targetModel: 'public-model' };
}

describe('P-RM-J1 text, model and stable identity', () => {
  it('maps a normal Responses message directly to a Messages response', () => {
    const result = responsesToMessagesResponseAdapter.convert(basic(), context());
    expect(responsesToMessagesResponseAdapter.from).toBe('responses');
    expect(responsesToMessagesResponseAdapter.to).toBe('messages');
    if (!result.ok) throw new Error('Expected direct response');
    expect(result.value.body).toEqual({ id: 'resp_rm_synthetic', type: 'message', role: 'assistant', model: 'public-model', content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } });
    expect(parseMessagesResponse(result.value.body).ok).toBe(true);
    expect(result.value.body.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
    expect(result.value.identity).toEqual({ responseId: 'resp_rm_synthetic', upstreamResponseId: 'resp_upstream' });
    expect(result.value.terminal).toMatchObject({ status: 'completed', reason: 'stop' });
    expect(JSON.stringify(result.value.body)).not.toContain('private-model');
  });

  it('preserves multiple text blocks and empty output without inventing separators', () => {
    const source = { ...basic(), output: [message('msg_one', 'First '), message('msg_two', '世界\n'), message('msg_three', '')] };
    const before = JSON.stringify(source);
    const result = responsesToMessagesResponse(source, context());
    if (!result.ok) throw new Error('Expected text conversion');
    expect(result.value.body.content).toEqual([{ type: 'text', text: 'First ' }, { type: 'text', text: '世界\n' }, { type: 'text', text: '' }]);
    expect(responsesToMessagesResponse(source, context())).toEqual(result);
    expect(JSON.stringify(source)).toBe(before);
    const empty = responsesToMessagesResponse({ ...basic(), output: [] }, context());
    if (!empty.ok) throw new Error('Expected empty output');
    expect(empty.value.body.content).toEqual([]);
  });

  it('accepts ordinary service tier, metadata and empty annotations as metadata', () => {
    const source = { ...basic(), service_tier: 'default', metadata: { trace: 'fixture' }, tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }], text: { format: { type: 'text' } }, output: [{ ...message(), content: [{ type: 'output_text', text: 'Hello', annotations: [] }] }] };
    expect(responsesToMessagesResponse(source, context()).ok).toBe(true);
  });

  it.each([{ extra: 'unknown' }, { status: 'in_progress' }, { object: 'not_response' }, { id: 'bad/id' }])('rejects unknown or nonordinary source case %#', (extra) => {
    expect(responsesToMessagesResponse({ ...basic(), ...extra }, context()).ok).toBe(false);
  });
});

const tool = (id = 'fc_one', call_id = 'call_one', argumentsText = ' {"city":"北京"}\n') => ({ type: 'function_call', id, call_id, name: 'lookup', arguments: argumentsText, status: 'completed' });

describe('P-RM-J2 function calls and ordered content blocks', () => {
  it('preserves message text followed by multiple tool calls and parses complete arguments', () => {
    const source = { ...basic(), output: [message('msg_one', 'Before '), tool(), tool('fc_two', 'call_two', '{}')] };
    const before = JSON.stringify(source);
    const result = responsesToMessagesResponse(source, context());
    if (!result.ok) throw new Error('Expected tool conversion');
    expect(result.value.body.content).toEqual([
      { type: 'text', text: 'Before ' },
      { type: 'tool_use', id: 'call_one', name: 'lookup', input: { city: '北京' } },
      { type: 'tool_use', id: 'call_two', name: 'lookup', input: {} },
    ]);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('distinguishes tool-only output from explicit empty text', () => {
    const toolOnly = responsesToMessagesResponse({ ...basic(), output: [tool()] }, context());
    const empty = responsesToMessagesResponse({ ...basic(), output: [message('msg_one', ''), tool()] }, context());
    if (!toolOnly.ok || !empty.ok) throw new Error('Expected tool output');
    expect(toolOnly.value.body.content).toEqual([{ type: 'tool_use', id: 'call_one', name: 'lookup', input: { city: '北京' } }]);
    expect(empty.value.body.content[0]).toEqual({ type: 'text', text: '' });
  });

  it('rejects text after tools, invalid arguments, duplicate IDs and invalid names', () => {
    expect(responsesToMessagesResponse({ ...basic(), output: [tool(), message('msg_after', 'after')] }, context())).toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
    for (const args of ['', '{', '[]', 'null', '"scalar"']) expect(responsesToMessagesResponse({ ...basic(), output: [tool('fc_one', 'call_one', args)] }, context())).toMatchObject({ ok: false, error: { code: 'invalid_tool_arguments' } });
    expect(responsesToMessagesResponse({ ...basic(), output: [tool(), tool('fc_two', 'call_one')] }, context()).ok).toBe(false);
    expect(responsesToMessagesResponse({ ...basic(), output: [tool('fc_one', 'bad/id')] }, context()).ok).toBe(false);
    const invalidName = tool(); invalidName.name = 'bad name';
    expect(responsesToMessagesResponse({ ...basic(), output: [invalidName] }, context()).ok).toBe(false);
  });
});

describe('P-RM-J3 native terminal semantics', () => {
  it('maps max_output_tokens incomplete status to Messages max_tokens', () => {
    const result = responsesToMessagesResponse({ ...basic(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [message('msg_one', 'partial')] }, context());
    if (!result.ok) throw new Error('Expected incomplete conversion');
    expect(result.value.body.stop_reason).toBe('max_tokens');
    expect(result.value.terminal).toMatchObject({ status: 'incomplete', reason: 'length' });
  });

  it('rejects content_filter because Messages has no equivalent stop reason', () => {
    expect(responsesToMessagesResponse({ ...basic(), status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [message('msg_one', 'partial')] }, context()).ok).toBe(false);
  });

  it('maps completed output with tools to Messages tool_use stop reason', () => {
    const result = responsesToMessagesResponse({ ...basic(), output: [tool()] }, context());
    if (!result.ok) throw new Error('Expected tool completion');
    expect(result.value.body.stop_reason).toBe('tool_use');
    expect(result.value.terminal).toMatchObject({ status: 'completed', reason: 'tool_calls' });
  });

  it('returns a safe Messages error for failed Responses status', () => {
    const result = responsesToMessagesResponse({ ...basic(), status: 'failed', output: [], error: { code: 'private', message: 'secret provider detail' } }, context());
    expect(result).toMatchObject({ ok: true, value: { body: { type: 'error', error: { type: 'api_error', message: 'The upstream service could not complete the request.' } }, terminal: { status: 'failed' } } });
    expect(JSON.stringify(result)).not.toContain('secret provider detail');
  });

  it.each(['queued', 'in_progress', 'cancelled', 'vendor_unknown'])('does not report %s as normal completion', (status) => {
    expect(responsesToMessagesResponse({ ...basic(), status }, context()).ok).toBe(false);
  });

  it('rejects inconsistent failure and incomplete metadata', () => {
    expect(responsesToMessagesResponse({ ...basic(), status: 'completed', error: { code: 'bad', message: 'bad' } }, context()).ok).toBe(false);
    expect(responsesToMessagesResponse({ ...basic(), status: 'completed', incomplete_details: { reason: 'max_output_tokens' } }, context()).ok).toBe(false);
    expect(responsesToMessagesResponse({ ...basic(), status: 'incomplete', incomplete_details: { reason: 'unknown' } }, context()).ok).toBe(false);
  });
});

describe('P-RM-J3-E standalone Responses errors', () => {
  it('returns a sanitized Messages error envelope and failed terminal', () => {
    const result = responsesToMessagesResponse({ error: { type: 'server_error', code: 'private-code', param: 'api_key', message: 'secret provider detail', provider_debug: 'private-debug' } }, context());
    expect(result).toMatchObject({ ok: true, value: { body: { type: 'error', error: { type: 'api_error', message: 'The upstream service could not complete the request.' } }, terminal: { status: 'failed' } } });
    for (const secret of ['private-code', 'api_key', 'secret provider detail', 'private-debug']) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([null, 'raw error', {}, { message: 1 }])('rejects malformed native error case %#', (error) => {
    expect(responsesToMessagesResponse({ error }, context()).ok).toBe(false);
  });

  it('rejects error mixtures and does not invoke nested error accessors', () => {
    expect(responsesToMessagesResponse({ error: { type: 'server_error', message: 'failed' }, output: [] }, context()).ok).toBe(false);
    let called = false;
    expect(responsesToMessagesResponse({ error: { type: 'server_error', get message() { called = true; throw new Error('private'); } } }, context()).ok).toBe(false);
    expect(called).toBe(false);
  });
});

const thought = (id = 'rs_one', text = 'Consider the constraints.') => ({ type: 'reasoning', id, summary: [{ type: 'summary_text', text }], status: 'completed' });

describe('P-RM-J3-T public reasoning and refusal content', () => {
  it('preserves ordered public summaries as unsigned Messages thinking blocks', () => {
    const result = responsesToMessagesResponse({ ...basic(), output: [thought(), message('msg_one', 'Answer')] }, context());
    if (!result.ok) throw new Error('Expected reasoning conversion');
    expect(result.value.body.content).toEqual([{ type: 'thinking', thinking: 'Consider the constraints.', signature: '' }, { type: 'text', text: 'Answer' }]);
  });

  it('keeps reasoning-only output out of visible text', () => {
    const result = responsesToMessagesResponse({ ...basic(), output: [thought()] }, context());
    if (!result.ok) throw new Error('Expected reasoning-only conversion');
    expect(result.value.body.content).toEqual([{ type: 'thinking', thinking: 'Consider the constraints.', signature: '' }]);
  });

  it.each([{ encrypted_content: 'opaque-private' }, { encrypted_content: '' }, { signature: 'opaque-private' }])('rejects private reasoning payload %# without leaking it', (extra) => {
    const source = { ...basic(), output: [{ ...thought(), ...extra }] };
    const result = responsesToMessagesResponse(source, context());
    if (extra.encrypted_content === '') expect(result.ok).toBe(true);
    else {
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('opaque-private');
    }
  });

  it('preserves refusal text separately from ordinary answer text', () => {
    const source = { ...basic(), output: [{ type: 'message', id: 'msg_one', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'Cannot comply.' }] }] };
    const result = responsesToMessagesResponse(source, context());
    if (!result.ok) throw new Error('Expected refusal conversion');
    expect(result.value.body).toMatchObject({ content: [{ type: 'text', text: 'Cannot comply.' }], stop_reason: 'refusal' });
    expect(result.value.terminal).toMatchObject({ status: 'incomplete', reason: 'refusal' });
  });

  it('rejects reasoning after visible text or mixed refusal/text', () => {
    expect(responsesToMessagesResponse({ ...basic(), output: [message(), thought()] }, context()).ok).toBe(false);
    const mixed = { ...basic(), output: [{ type: 'message', id: 'msg_one', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer', annotations: [] }, { type: 'refusal', refusal: 'no' }] }] };
    expect(responsesToMessagesResponse(mixed, context()).ok).toBe(false);
  });
});

describe('P-RM-J4 usage display without remeasurement', () => {
  it('converts inclusive Responses input counts to Messages cache-exclusive counts once', () => {
    const source = { ...basic(), usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19,
      input_tokens_details: { cached_tokens: 5, cache_write_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } } };
    const result = responsesToMessagesResponse(source, context());
    if (!result.ok) throw new Error('Expected usage conversion');
    expect(result.value.body.usage).toEqual({ input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 4, output_tokens_details: { thinking_tokens: 3 } });
  });

  it('maps known no-cache counts and observed zeros without inventing total tokens', () => {
    const result = responsesToMessagesResponse({ ...basic(), usage: { input_tokens: 4, output_tokens: 3 } }, context());
    if (!result.ok) throw new Error('Expected usage conversion');
    expect(result.value.body.usage).toEqual({ input_tokens: 4, output_tokens: 3 });
    const zero = responsesToMessagesResponse({ ...basic(), usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }, context());
    if (!zero.ok) throw new Error('Expected zero usage conversion');
    expect(zero.value.body.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: 0 } });
  });

  it.each([null, {}, { input_tokens: 4 }, { input_tokens: 4, output_tokens: 3, total_tokens: 100 }])('rejects incomplete or contradictory usage case %#', (usage) => {
    const result = responsesToMessagesResponse({ ...basic(), usage }, context());
    expect(result).toMatchObject({ ok: false, error: { code: 'usage_not_representable', param: '$.usage' } });
  });

  it('keeps residual input when only one cache subdivision is reported', () => {
    const result = responsesToMessagesResponse({ ...basic(), usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19, input_tokens_details: { cached_tokens: 5 } } }, context());
    if (!result.ok) throw new Error('Expected residual usage display');
    expect(result.value.body.usage).toEqual({ input_tokens: 7, output_tokens: 7, cache_read_input_tokens: 5 });
    expect(Object.hasOwn(result.value.body.usage!, 'cache_creation_input_tokens')).toBe(false);
  });

  it('rejects unknown counters and malformed detail values', () => {
    for (const usage of [
      { input_tokens: 1, output_tokens: 1, cost: 99 },
      { input_tokens: -1, output_tokens: 1 },
      { input_tokens: 1, output_tokens: 1, input_tokens_details: { private_counter: 1 } },
      { input_tokens: 1, output_tokens: 1, output_tokens_details: { reasoning_tokens: '1' } },
    ]) expect(responsesToMessagesResponse({ ...basic(), usage }, context()).ok).toBe(false);
  });
});
