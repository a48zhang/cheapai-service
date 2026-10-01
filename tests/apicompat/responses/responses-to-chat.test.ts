/** SPDX-License-Identifier: LGPL-3.0-only
 * Original synthetic tests for the pinned behavioral adaptation in responses-to-chat.ts.
 * No upstream fixture or model recording copied.
 */
import { describe, expect, it } from 'vitest';
import { responsesToChatResponse, responsesToChatResponseAdapter } from '../../../packages/apicompat/responses/responses-to-chat.js';
import { createResponseIds } from '../../../packages/apicompat/ids.js';
import { parseChatResponse } from '../../../packages/apicompat/types/chat.js';
import type { ResponseContext } from '../../../packages/apicompat/types/adapter.js';
import { extractResponsesUsage } from '../../../packages/apicompat/usage/responses.js';
import { extractChatUsage } from '../../../packages/apicompat/usage/chat.js';

const message = (id = 'msg_one', text = 'Hello') => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const basic = () => ({ id: 'resp_upstream', object: 'response', created_at: 123, model: 'private-model', status: 'completed', output: [message()] });
function context(): ResponseContext {
  const ids = createResponseIds({ seed: 'rc_synthetic', upstreamResponseId: 'resp_upstream' });
  if (!ids.ok) throw new Error('Invalid fixture IDs');
  return { identity: ids.value.identity, idFor: ids.value.idFor, createdAt: 456, targetModel: 'public-model' };
}

describe('P-RC-J1 direct text/model/ID mapping', () => {
  it('emits a native Chat completion with stable caller identity and public model', () => {
    const result = responsesToChatResponseAdapter.convert(basic(), context());
    expect(responsesToChatResponseAdapter.from).toBe('responses');
    expect(responsesToChatResponseAdapter.to).toBe('chat');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toEqual({ id: 'resp_rc_synthetic', object: 'chat.completion', created: 456, model: 'public-model', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }] });
    expect(result.value.identity).toEqual({ responseId: 'resp_rc_synthetic', upstreamResponseId: 'resp_upstream' });
    expect(parseChatResponse(result.value.body).ok).toBe(true);
  });

  it('joins multiple ordinary message/text items in exact order without invented separators', () => {
    const source = basic();
    source.output[0]!.content.push({ type: 'output_text', text: ' 世界\n', annotations: [] });
    source.output.push(message('msg_two', 'last'));
    const result = responsesToChatResponse(source, context());
    if (!result.ok) throw new Error('Expected ordinary multiple-item conversion');
    expect(result.value.body.choices[0]?.message.content).toBe('Hello 世界\nlast');
  });

  it('preserves empty text versus an absence of text and preserves raw JSON text', () => {
    for (const text of ['', ' {"answer":42}\n']) {
      const result = responsesToChatResponse({ ...basic(), output: [message('msg_one', text)] }, context());
      if (!result.ok) throw new Error('Expected text');
      expect(result.value.body.choices[0]?.message.content).toBe(text);
    }
    const empty = responsesToChatResponse({ ...basic(), output: [] }, context());
    if (!empty.ok) throw new Error('Expected no-text response');
    expect(empty.value.body.choices[0]?.message.content).toBeNull();
  });

  it('is stable and does not mutate upstream data', () => {
    const source = basic(); const before = JSON.stringify(source); const ctx = context();
    expect(responsesToChatResponse(source, ctx)).toEqual(responsesToChatResponse(source, ctx));
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each([{ extra: 'unknown' }])('rejects unimplemented fields case %#', (extra) => {
    expect(responsesToChatResponse({ ...basic(), ...extra }, context()).ok).toBe(false);
  });

  it.each(['web_search_call'])('does not silently consume unsupported %s output', (type) => {
    expect(responsesToChatResponse({ ...basic(), output: [{ type }] }, context()).ok).toBe(false);
  });

  it('rejects annotations that do not fit the target text contract', () => {
    const source = { ...basic(), output: [{ ...message(), content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'url_citation' }] }] }] };
    expect(responsesToChatResponse(source, context()).ok).toBe(false);
  });

  it.each([{ status: 'incomplete' }, { created_at: -1 }, { output: null }, { id: 'bad/id' }])('rejects invalid/unimplemented source case %#', (extra) => {
    expect(responsesToChatResponse({ ...basic(), ...extra }, context()).ok).toBe(false);
  });

  it('rejects duplicate item IDs, malformed context and accessors without invoking them', () => {
    expect(responsesToChatResponse({ ...basic(), output: [message(), message()] }, context()).ok).toBe(false);
    expect(responsesToChatResponse(basic(), { ...context(), targetModel: '' }).ok).toBe(false);
    let called = false;
    expect(responsesToChatResponse({ ...basic(), get output() { called = true; throw new Error('secret'); } }, context()).ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('RC-JSON-STANDARD full ordinary Responses envelopes', () => {
  it('accepts verified standard response echoes without treating tool declarations as tool output', () => {
    const source = { ...basic(), completed_at: 124, background: false, error: null, incomplete_details: null,
      instructions: 'private instruction echo', max_output_tokens: null, max_tool_calls: null,
      parallel_tool_calls: true, previous_response_id: 'resp_previous', reasoning: { effort: null, summary: null },
      service_tier: 'default', store: true, temperature: 1, top_p: 1, top_logprobs: 0,
      text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
      truncation: 'disabled', user: null, metadata: { trace: 'not answer text' },
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    };
    const before = JSON.stringify(source);
    const result = responsesToChatResponse(source, context());
    if (!result.ok) throw new Error('Expected ordinary full response envelope');
    expect(result.value.body.service_tier).toBe('default');
    expect(result.value.body.choices[0]).toMatchObject({ finish_reason: 'stop', message: { content: 'Hello' } });
    expect(Object.hasOwn(result.value.body.choices[0]!.message, 'tool_calls')).toBe(false);
    expect(JSON.stringify(result.value.body)).not.toContain('private instruction echo');
    expect(JSON.stringify(result.value.body)).not.toContain('not answer text');
    expect(JSON.stringify(source)).toBe(before);
  });
  it('does not reparse or rewrite structured output merely because the response echoes a schema', () => {
    const source = { ...basic(), output: [message('msg_one', '{"answer":42}')],
      text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true }, verbosity: 'low' },
      service_tier: 'priority', output_text: '{"answer":42}',
    };
    const result = responsesToChatResponse(source, context());
    if (!result.ok) throw new Error('Expected structured output text');
    expect(result.value.body.choices[0]?.message.content).toBe('{"answer":42}');
    expect(result.value.body.service_tier).toBe('priority');
  });
  it.each([{ temperature: '1' }, { top_p: 2 }, { tools: 'not an array' }, { service_tier: {} }, { metadata: { nested: {} } }, { output_text: 'conflicting aggregate' }])('still rejects malformed known metadata case %#', (extra) => {
    expect(responsesToChatResponse({ ...basic(), ...extra }, context()).ok).toBe(false);
  });
  it('maps final-answer and tool-commentary phases explicitly, without collapsing mixed phases', () => {
    expect(responsesToChatResponse({ ...basic(), output: [{ ...message(), phase: 'final_answer' }] }, context()).ok).toBe(true);
    expect(responsesToChatResponse({ ...basic(), output: [{ ...message(), phase: 'commentary' }, tool()] }, context()).ok).toBe(true);
    expect(responsesToChatResponse({ ...basic(), output: [{ ...message(), phase: 'commentary' }, { ...message('msg_two'), phase: 'final_answer' }] }, context()).ok).toBe(false);
    expect(responsesToChatResponse({ ...basic(), output: [{ ...message(), phase: 'commentary' }] }, context()).ok).toBe(false);
  });
  it('keeps schema nullability and accepts an empty text configuration', () => {
    expect(responsesToChatResponse({ ...basic(), text: {}, service_tier: 'fast' }, context()).ok).toBe(true);
    for (const extra of [{ parallel_tool_calls: null }, { tools: null }, { text: null }, { prompt_cache_options: null }]) {
      expect(responsesToChatResponse({ ...basic(), ...extra }, context()).ok).toBe(false);
    }
  });
});

describe('P-RC-J4 original usage display without remeasurement', () => {
  it('preserves inclusive cache/reasoning counts without double addition', () => {
    const source = { ...basic(), usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } } };
    const before = JSON.stringify(source);
    const ctx = context();
    const result = responsesToChatResponse(source, ctx);
    if (!result.ok) throw new Error('Expected usage display');
    expect(result.value.body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 } });
    // Cross-extractor check is test-only. Accounting reads original upstream P13.
    const original = extractResponsesUsage(source);
    const display = extractChatUsage(result.value.body);
    if (original.quality !== 'complete' || display.quality !== 'complete') throw new Error('Expected complete fixture evidence');
    expect(display.counts).toEqual(original.counts);
    expect(responsesToChatResponse(source, ctx)).toEqual(result);
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each([
    [{ input_tokens: 4 }, { prompt_tokens: 4 }],
    [{ output_tokens: 3 }, { completion_tokens: 3 }],
    [{ total_tokens: 7 }, { total_tokens: 7 }],
    [{ input_tokens_details: { cache_write_tokens: 2 } }, { prompt_tokens_details: { cache_write_tokens: 2 } }],
    [{}, {}],
  ])('retains known partial fields without inventing missing counts case %#', (usage, expected) => {
    const result = responsesToChatResponse({ ...basic(), usage }, context());
    if (!result.ok) throw new Error('Expected partial display');
    expect(result.value.body.usage).toEqual(expected);
    expect(extractChatUsage(result.value.body).quality).toBe('partial');
  });

  it('derives only a total from known components and preserves observed zeros', () => {
    const result = responsesToChatResponse({ ...basic(), usage: { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }, context());
    if (!result.ok) throw new Error('Expected known zero counts');
    expect(result.value.body.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } });
  });

  it.each([null, { input_tokens: 4, output_tokens: 3, total_tokens: 100 }, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }])('does not turn missing or contradictory evidence into exact usage case %#', (usage) => {
    const result = responsesToChatResponse({ ...basic(), usage }, context());
    if (!result.ok) throw new Error('Expected answer without exact usage');
    expect(Object.hasOwn(result.value.body, 'usage')).toBe(false);
  });

  it('rejects unknown counters, nonzero unmapped modalities and malformed counts', () => {
    for (const usage of [
      { input_tokens: -1 }, { input_tokens: '1' }, { cost_units: 100 },
      { input_tokens: 1, output_tokens: 1, output_tokens_details: { audio_tokens: 1 } },
      { input_tokens_details: { private_counter: 1 } },
    ]) expect(responsesToChatResponse({ ...basic(), usage }, context()).ok).toBe(false);
  });
});

const thought = (id = 'rs_one', text = 'First thought.') => ({ type: 'reasoning', id, summary: [{ type: 'summary_text', text }] });

describe('P-RC-J3-T public reasoning without private-data downgrade', () => {
  it('accepts multiple reasoning/text/tool runs with exact within-kind order', () => {
    const first = thought(); first.summary.push({ type: 'summary_text', text: ' Next fragment.' });
    const result = responsesToChatResponse({ ...basic(), output: [first, thought('rs_two', 'Last thought.'), message('msg_one', 'Answer '), message('msg_two', 'text'), tool(), tool('fc_two', 'call_two')] }, context());
    if (!result.ok) throw new Error('Expected ordered mixed output');
    expect(result.value.body.choices[0]?.message).toMatchObject({ reasoning_content: 'First thought. Next fragment.Last thought.', content: 'Answer text', tool_calls: [{ id: 'call_one' }, { id: 'call_two' }] });
  });

  it('keeps reasoning-only output out of visible content', () => {
    const result = responsesToChatResponse({ ...basic(), output: [thought()] }, context());
    if (!result.ok) throw new Error('Expected reasoning output');
    expect(result.value.body.choices[0]?.message).toMatchObject({ content: null, reasoning_content: 'First thought.' });
  });

  it.each([{ encrypted_content: 'opaque-private' }, { encrypted_content: '' }, { signature: 'opaque-private' }, { content: [{ type: 'reasoning_text', text: 'private form' }] }])('rejects private/unmapped reasoning fields case %#', (extra) => {
    const result = responsesToChatResponse({ ...basic(), output: [{ ...thought(), ...extra }] }, context());
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('opaque-private');
  });

  it('rejects thinking that follows visible text instead of moving it to a fake prefix', () => {
    expect(responsesToChatResponse({ ...basic(), output: [message(), thought()] }, context())).toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
    expect(responsesToChatResponse({ ...basic(), output: [tool(), thought()] }, context()).ok).toBe(false);
  });

  it('preserves incomplete reasoning under the real incomplete finish reason', () => {
    const result = responsesToChatResponse({ ...basic(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ ...thought(), status: 'incomplete', encrypted_content: null }] }, context());
    if (!result.ok) throw new Error('Expected incomplete thinking');
    expect(result.value.body.choices[0]).toMatchObject({ finish_reason: 'length', message: { reasoning_content: 'First thought.', content: null } });
  });
});

const tool = (id = 'fc_one', callId = 'call_one', argumentsText = ' {"x":1}\n') => ({ type: 'function_call', id, call_id: callId, name: 'lookup', arguments: argumentsText, status: 'completed' });

describe('P-RC-J2 functions and representable output order', () => {
  it('accepts several message items followed by multiple functions, keeping parameters and IDs exact', () => {
    const source = { ...basic(), output: [message('msg_one', 'First '), message('msg_two', 'second'), tool(), tool('fc_two', 'call_two', '{}')] };
    const result = responsesToChatResponse(source, context());
    if (!result.ok) throw new Error('Expected multi-item conversion');
    expect(result.value.body.choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { content: 'First second', tool_calls: [
      { id: 'call_one', type: 'function', function: { name: 'lookup', arguments: ' {"x":1}\n' } },
      { id: 'call_two', type: 'function', function: { name: 'lookup', arguments: '{}' } },
    ] } });
  });

  it('distinguishes tool-only null content from explicitly empty text', () => {
    for (const [output, content] of [[ [tool()], null ], [ [message('msg_one', ''), tool()], '' ]] as const) {
      const result = responsesToChatResponse({ ...basic(), output }, context());
      if (!result.ok) throw new Error('Expected tools');
      expect(result.value.body.choices[0]?.message.content).toBe(content);
    }
  });

  it('rejects visible text after a function instead of losing cross-kind ordering', () => {
    expect(responsesToChatResponse({ ...basic(), output: [tool(), message('msg_after', 'after tool')] }, context())).toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
  });

  it.each(['', '{', '[]', 'null', '"scalar"'])('does not repair or drop invalid complete arguments case %#', (args) => {
    expect(responsesToChatResponse({ ...basic(), output: [tool('fc_one', 'call_one', args)] }, context())).toMatchObject({ ok: false, error: { code: 'invalid_tool_arguments' } });
  });

  it('rejects duplicate call IDs and unrepresentable IDs', () => {
    expect(responsesToChatResponse({ ...basic(), output: [tool(), tool('fc_two')] }, context()).ok).toBe(false);
    expect(responsesToChatResponse({ ...basic(), output: [tool('fc_one', 'bad/id')] }, context()).ok).toBe(false);
  });
});

describe('P-RC-J3 final states and refusal', () => {
  it.each([['max_output_tokens', 'length'], ['content_filter', 'content_filter']])('maps incomplete %s exactly', (reason, finishReason) => {
    const result = responsesToChatResponse({ ...basic(), status: 'incomplete', incomplete_details: { reason }, output: [{ ...message(), status: 'incomplete' }] }, context());
    if (!result.ok) throw new Error('Expected incomplete conversion');
    expect(result.value.body.choices[0]?.finish_reason).toBe(finishReason);
    expect(result.value.terminal).toMatchObject({ status: 'incomplete', reason: finishReason });
  });

  it('preserves partial arguments under an incomplete terminal, without falsely completing the call', () => {
    const result = responsesToChatResponse({ ...basic(), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ ...tool('fc_one', 'call_one', '{"x":'), status: 'incomplete' }] }, context());
    if (!result.ok) throw new Error('Expected incomplete tool conversion');
    expect(result.value.body.choices[0]).toMatchObject({ finish_reason: 'length', message: { tool_calls: [{ function: { arguments: '{"x":' } }] } });
  });

  it('preserves refusal payloads separately from ordinary answer text', () => {
    const result = responsesToChatResponse({ ...basic(), output: [{ ...message(), content: [{ type: 'refusal', refusal: 'Not supported.' }] }] }, context());
    if (!result.ok) throw new Error('Expected refusal conversion');
    expect(result.value.body.choices[0]).toMatchObject({ finish_reason: 'stop', message: { content: null, refusal: 'Not supported.' } });
    expect(result.value.terminal).toMatchObject({ status: 'incomplete', reason: 'refusal' });
  });

  it('maps failed status to a safe Chat error instead of an ordinary completion', () => {
    const result = responsesToChatResponse({ ...basic(), status: 'failed', output: [], error: { code: 'private', message: 'secret provider details' } }, context());
    expect(result).toMatchObject({ ok: true, value: { body: { error: { code: 'upstream_error', type: 'server_error' } }, terminal: { status: 'failed' } } });
    expect(JSON.stringify(result)).not.toContain('secret provider details');
  });

  it.each(['queued', 'in_progress', 'cancelled', 'vendor_unknown'])('never reports %s as normal stop', (status) => {
    expect(responsesToChatResponse({ ...basic(), status }, context()).ok).toBe(false);
  });

  it('rejects unknown incomplete reasons and failed responses whose partial output has no error-envelope representation', () => {
    expect(responsesToChatResponse({ ...basic(), status: 'incomplete', incomplete_details: { reason: 'unknown' } }, context()).ok).toBe(false);
    expect(responsesToChatResponse({ ...basic(), status: 'failed', error: { code: 'failed', message: 'detail' } }, context()).ok).toBe(false);
  });
});

describe('P-RC-J3-E standalone native errors', () => {
  it('returns a safe Chat error envelope without leaking sensitive native diagnostics', () => {
    const result = responsesToChatResponse({ error: { type: 'invalid_request_error', code: 'private-code', param: 'api_key', message: 'secret credential at https://private.example', provider_debug: 'private-debug' } }, context());
    expect(result).toMatchObject({ ok: true, value: { body: { error: { type: 'server_error', code: 'upstream_error', param: null } }, terminal: { status: 'failed' } } });
    for (const secret of ['private-code', 'api_key', 'secret credential', 'private.example', 'private-debug']) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([null, 'raw error', {}, { message: 1 }])('rejects malformed native error case %#', (error) => {
    expect(responsesToChatResponse({ error }, context()).ok).toBe(false);
  });

  it('does not invoke accessors embedded in an error or publish success/error mixtures', () => {
    let called = false;
    const input = { error: { get message() { called = true; throw new Error('private'); } } };
    expect(responsesToChatResponse(input, context()).ok).toBe(false);
    expect(called).toBe(false);
    expect(responsesToChatResponse({ error: { message: 'failed' }, output: [message()] }, context()).ok).toBe(false);
  });
});
