import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { convertResponsesToChatRequest, responsesToChatRequestAdapter } from '../../../packages/apicompat/requests/responses-to-chat.js';
import type { RequestAdapter } from '../../../packages/apicompat/types/adapter.js';
import { parseChatRequest } from '../../../packages/apicompat/types/chat.js';
import type { ChatRequest } from '../../../packages/apicompat/types/chat.js';
import type { ResponsesInputItem, ResponsesRequest } from '../../../packages/apicompat/types/responses.js';
import type { ConversionResult } from '../../../packages/apicompat/types/shared.js';

// Original synthetic cases; no upstream test bodies or provider recordings copied.
function value<T>(result: ConversionResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
const context = { targetModel: 'configured-chat-model' };
const basic = (): ResponsesRequest => ({ model: 'public-name', input: 'hello' });

describe('Responses→Chat text request milestone', () => {
  it('implements the direct RequestAdapter and turns bare input into one user message', () => {
    expectTypeOf(responsesToChatRequestAdapter).toEqualTypeOf<RequestAdapter<ResponsesRequest, ChatRequest, 'responses', 'chat'>>();
    expect(responsesToChatRequestAdapter).toMatchObject({ from: 'responses', to: 'chat' });
    const output = value(responsesToChatRequestAdapter.convert(basic(), context));
    expect(output).toEqual({ model: context.targetModel, messages: [{ role: 'user', content: 'hello' }] });
    expect(parseChatRequest(output).ok).toBe(true);
  });

  it('prepends instructions once while preserving every native role and message position', () => {
    const request: ResponsesRequest = { model: 'm', instructions: 'global instruction', input: [
      { role: 'system', content: 'system layer' },
      { role: 'developer', content: [{ type: 'input_text', text: 'developer layer' }] },
      { role: 'user', content: 'first question' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first answer', annotations: [] }] },
      { role: 'developer', content: 'late developer instruction' },
      { role: 'system', content: 'late system instruction' },
      { role: 'user', content: 'next question' },
    ] };
    const output = value(convertResponsesToChatRequest(request, context));
    expect(output.messages).toEqual([
      { role: 'system', content: 'global instruction' },
      { role: 'system', content: 'system layer' },
      { role: 'developer', content: [{ type: 'text', text: 'developer layer' }] },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      { role: 'developer', content: 'late developer instruction' },
      { role: 'system', content: 'late system instruction' },
      { role: 'user', content: 'next question' },
    ]);
    expect(parseChatRequest(output).ok).toBe(true);
  });

  it('retains adjacent messages and ordered text blocks without synthetic separators', () => {
    const output = value(convertResponsesToChatRequest({ model: 'm', input: [
      { role: 'user', content: [{ type: 'input_text', text: ' a\n' }, { type: 'input_text', text: 'b' }] },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: [{ type: 'input_text', text: 'd' }, { type: 'output_text', text: 'e', annotations: [] }] },
    ] }, context));
    expect(output.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: ' a\n' }, { type: 'text', text: 'b' }] },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: [{ type: 'text', text: 'd' }, { type: 'text', text: 'e' }] },
    ]);
  });

  it.each(['', '  ', '\n'])('does not discard explicit instructions or empty text %#', instructions => {
    expect(value(convertResponsesToChatRequest({ model: 'm', instructions, input: '' }, context)).messages)
      .toEqual([{ role: 'system', content: instructions }, { role: 'user', content: '' }]);
  });

  it('treats null instructions as absent and does not fabricate input for an empty array', () => {
    expect(value(convertResponsesToChatRequest({ ...basic(), instructions: null }, context)).messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(convertResponsesToChatRequest({ model: 'm', input: [] }, context)).toMatchObject({ ok: false, error: { code: 'chat_messages_required' } });
    expect(value(convertResponsesToChatRequest({ model: 'm', instructions: 'only instruction', input: [] }, context)).messages)
      .toEqual([{ role: 'system', content: 'only instruction' }]);
  });

  it.each([
    { store: false }, { background: false },
    { metadata: {} },
    { previous_response_id: 'provider-response' }, { previous_response_id: null },
    { vendor_option: { active: true } },
  ])('rejects advanced controls/extensions %j without dropping them', extra => {
    expect(convertResponsesToChatRequest({ ...basic(), ...extra } as ResponsesRequest, context))
      .toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
  });

  it.each([
    { type: 'function_call', call_id: 'call', name: 'f', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call', output: 'result' },
    { type: 'item_reference', id: 'provider-item' },
    { type: 'reasoning', id: 'reasoning-id', summary: [] },
    { role: 'user', content: [{ type: 'input_file', file_id: 'file-id' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'url_citation', url: 'https://example.test' }] }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'x', annotations: [], logprobs: [] }] },
    { role: 'user', content: [{ type: 'input_text', text: 'x', vendor: true }] },
    { role: 'user', content: 'x', vendor: true },
  ])('rejects advanced input item/block %# explicitly', item => {
    expect(convertResponsesToChatRequest({ model: 'm', input: [item as ResponsesInputItem] }, context))
      .toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
  });

  it('requires valid source structure and targetModel without reflecting contents', () => {
    const malformed = { model: 'm', input: [{ role: 'user', content: { secret: 'private-history' } }] } as unknown as ResponsesRequest;
    const result = convertResponsesToChatRequest(malformed, context);
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    expect(JSON.stringify(result)).not.toContain('private-history');
    expect(convertResponsesToChatRequest(basic(), { targetModel: '' })).toMatchObject({ ok: false, error: { code: 'invalid_target_model' } });
  });

  it('copies text blocks without mutating input or retaining response-to-response state', () => {
    const part = Object.freeze({ type: 'input_text' as const, text: 'immutable' });
    const request = Object.freeze({ model: 'm', instructions: 'one call only', input: Object.freeze([
      Object.freeze({ role: 'user' as const, content: Object.freeze([part]) }),
    ]) });
    const first = value(convertResponsesToChatRequest(request, Object.freeze(context)));
    expect(first.messages[1]?.content).not.toBe(request.input[0]?.content);
    expect(first.messages[1]?.content?.[0]).not.toBe(part);
    expect(value(convertResponsesToChatRequest(basic(), { targetModel: 'different' })))
      .toEqual({ model: 'different', messages: [{ role: 'user', content: 'hello' }] });
  });
});

describe('P-RC-Q5 effort without private-history invention', () => {
  const options = { channelCapabilities: { protocol: 'chat' as const, features: ['reasoning_effort'] as const, reasoningEfforts: ['none', 'low', 'medium', 'high'] } };
  it.each(['none', 'low', 'medium', 'high'])('maps approved effort %s literally', effort => {
    const output = value(convertResponsesToChatRequest({ ...basic(), reasoning: { effort } }, context, options));
    expect(output.reasoning_effort).toBe(effort); expect(output).not.toHaveProperty('thinking');
  });
  it('preserves effort values without capability declarations or invented defaults', () => {
    expect(convertResponsesToChatRequest({ ...basic(), reasoning: { effort: 'high' } }, context).ok).toBe(true);
    expect(convertResponsesToChatRequest({ ...basic(), reasoning: { effort: 'unknown' } }, context, options).ok).toBe(true);
    expect(value(convertResponsesToChatRequest({ ...basic(), reasoning: { effort: null } }, context))).not.toHaveProperty('reasoning_effort');
  });
  it.each([{ effort: 'high', summary: 'auto' }, { encrypted_content: 'PRIVATE' }, { budget_tokens: 1234 }, { effort: false }])('rejects unrepresentable reasoning config %#', reasoning => {
    const result = convertResponsesToChatRequest({ ...basic(), reasoning }, context, options);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('does not map native encrypted/private reasoning items into assistant text', () => {
    const result = convertResponsesToChatRequest({ model: 'm', input: [{ type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'PRIVATE' }], encrypted_content: 'PRIVATE' }] }, context, options);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});

describe('P-RC-Q4-O output format', () => {
  const options = { channelCapabilities: { protocol: 'chat' as const, features: ['json_object', 'json_schema'] as const } };
  it.each(['text', 'json_object'])('maps text.format %s', type => {
    expect(convertResponsesToChatRequest({ ...basic(), text: { format: { type } } }, context, options)).toMatchObject({ ok: true, value: { response_format: { type } } });
  });
  it.each([true, false, null, undefined])('preserves schema and strict=%s without normalization', strict => {
    const schema = { type: 'object', properties: { result: { type: 'string' } } };
    const format = { type: 'json_schema', name: 'result', schema, description: 'A result', ...(strict === undefined ? {} : { strict }) };
    const result = value(convertResponsesToChatRequest({ ...basic(), text: { format } }, context, options));
    expect(result.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'result', schema, description: 'A result', ...(strict === undefined ? {} : { strict }) } });
    expect(parseChatRequest(result).ok).toBe(true);
  });
  it('accepts undeclared output formats but rejects unknown format constraints', () => {
    expect(convertResponsesToChatRequest({ ...basic(), text: { format: { type: 'json_object' } } }, context).ok).toBe(true);
    for (const text of [{ verbosity: 'low' }, { format: { type: 'json_object', vendor: true } }, { format: { type: 'json_schema', name: 'x' } }]) {
      expect(convertResponsesToChatRequest({ ...basic(), text }, context, options).ok).toBe(false);
    }
  });
});

describe('P-RC-Q4 output controls', () => {
  const options = { channelCapabilities: { protocol: 'chat' as const, features: ['temperature', 'top_p', 'streaming', 'stream_usage'] as const, maxOutputTokens: 256 } };
  it('maps limit/sampling/stream without modifying literal values', () => {
    expect(convertResponsesToChatRequest({ ...basic(), max_output_tokens: 200, temperature: 0, top_p: 1, stream: true }, context, options))
      .toMatchObject({ ok: true, value: { max_completion_tokens: 200, temperature: 0, top_p: 1, stream: true } });
    expect(convertResponsesToChatRequest({ ...basic(), max_output_tokens: 257 }, context, options).ok).toBe(false);
  });
  it('retains false stream and omits null controls without inventing defaults', () => {
    const result = value(convertResponsesToChatRequest({ ...basic(), stream: false, max_output_tokens: null, temperature: null, top_p: null }, context));
    expect(result.stream).toBe(false); expect(result).not.toHaveProperty('temperature'); expect(result).not.toHaveProperty('max_completion_tokens');
  });
  it('accepts undeclared sampling but rejects malformed controls or stop extensions', () => {
    expect(convertResponsesToChatRequest({ ...basic(), top_p: 0.5 }, context).ok).toBe(true);
    expect(convertResponsesToChatRequest({ ...basic(), top_p: 0.5 }, context, { channelCapabilities: { protocol: 'chat', features: [] } }).ok).toBe(true);
    for (const patch of [{ max_output_tokens: 0 }, { temperature: 3 }, { top_p: -1 }, { stop: ['END'] }, { max_tokens: 10 }]) expect(convertResponsesToChatRequest({ ...basic(), ...patch }, context, options).ok).toBe(false);
  });
});

describe('P-RC-Q6 completed history and known options', () => {
  const options = { channelCapabilities: { protocol: 'chat' as const, features: ['streaming', 'stream_usage', 'tools', 'strict_tools', 'refusal_history'] as const } };
  it('requests Chat usage explicitly for Responses streams', () => {
    expect(convertResponsesToChatRequest({ ...basic(), stream: true }, context, options)).toMatchObject({ ok: true, value: { stream: true, stream_options: { include_usage: true } } });
    expect(convertResponsesToChatRequest({ ...basic(), stream: true }, context, { channelCapabilities: { protocol: 'chat', features: ['streaming'] } }).ok).toBe(true);
  });
  it('keeps call_id rather than source item IDs and accepts complete native items', () => {
    const result = value(convertResponsesToChatRequest({ model: 'm', input: [
      { type: 'message', id: 'msg_source', status: 'completed', role: 'user', content: 'x' },
      { type: 'function_call', id: 'fc_source', status: 'completed', call_id: 'call_actual', name: 'f', arguments: '{}' },
      { type: 'function_call_output', id: 'output_source', status: 'completed', call_id: 'call_actual', output: 'result' },
    ] }, context, options));
    expect(result.messages).toMatchObject([{ role: 'user' }, { tool_calls: [{ id: 'call_actual' }] }, { tool_call_id: 'call_actual' }]);
    expect(JSON.stringify(result)).not.toContain('source');
  });
  it('preserves refusal content without turning it into ordinary text', () => {
    const result = value(convertResponsesToChatRequest({ model: 'm', input: [{ role: 'assistant', content: [{ type: 'refusal', refusal: 'Declined' }] }] }, context, options));
    expect(result.messages).toEqual([{ role: 'assistant', content: [{ type: 'refusal', refusal: 'Declined' }] }]);
  });
  it('rejects incomplete items, source references, caching and unreviewed fields', () => {
    for (const status of ['in_progress', 'incomplete'] as const) expect(convertResponsesToChatRequest({ model: 'm', input: [{ role: 'assistant', status, content: 'partial' }] }, context, options).ok).toBe(false);
    for (const patch of [{ previous_response_id: 'response' }, { prompt_cache_key: 'cache' }, { cache_control: { type: 'ephemeral' } }, { metadata: {} }, { store: false }])
      expect(convertResponsesToChatRequest({ ...basic(), ...patch }, context, options).ok).toBe(false);
    expect(convertResponsesToChatRequest({ model: 'm', input: [{ type: 'item_reference', id: 'source' }] }, context, options).ok).toBe(false);
  });
  it('preserves generated strict-tool semantics without capability declarations', () => {
    const request: ResponsesRequest = { ...basic(), tools: [{ type: 'function', name: 'f', parameters: { type: 'object', properties: {} } }] };
    expect(convertResponsesToChatRequest(request, context, { channelCapabilities: { protocol: 'chat', features: ['tools'] } }).ok).toBe(true);
    expect(convertResponsesToChatRequest(request, context, options).ok).toBe(true);
  });
});

describe('P-RC-Q3 images', () => {
  const options = { channelCapabilities: { protocol: 'chat' as const, features: ['image_url', 'image_base64', 'image_detail'] as const } };
  const request = (image_url: string, detail?: 'auto' | 'low' | 'high' | 'original'): ResponsesRequest => ({ model: 'm', input: [{ role: 'user', content: [
    { type: 'input_text', text: 'before' }, { type: 'input_image', image_url, ...(detail ? { detail } : {}) }, { type: 'input_text', text: 'after' },
  ] }] });
  it.each(['auto', 'low', 'high'] as const)('preserves %s detail and URL without fetching', detail => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('no fetch'); });
    try {
      const result = value(convertResponsesToChatRequest(request('https://image.example/x', detail), context, options));
      expect(result.messages[0]).toMatchObject({ content: [{ text: 'before' }, { type: 'image_url', image_url: { url: 'https://image.example/x', detail } }, { text: 'after' }] });
      expect(parseChatRequest(result).ok).toBe(true); expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it.each(['png', 'jpeg', 'gif', 'webp', 'svg+xml'])('preserves data URI type %s', subtype => {
    const url = `data:image/${subtype};base64,AQID`;
    expect(convertResponsesToChatRequest(request(url), context, options)).toMatchObject({ ok: true, value: { messages: [{ content: [{ text: 'before' }, { image_url: { url } }, { text: 'after' }] }] } });
  });
  it('preserves HTTP image URLs with query and fragment', () => {
    const url = 'http://images.local/photo?format=original#part';
    expect(convertResponsesToChatRequest(request(url), context)).toMatchObject({ ok: true, value: { messages: [{ content: [{ text: 'before' }, { image_url: { url } }, { text: 'after' }] }] } });
  });
  it('accepts undeclared image transport but rejects unrepresentable file IDs and detail', () => {
    expect(convertResponsesToChatRequest(request('https://image.example/x'), context).ok).toBe(true);
    expect(convertResponsesToChatRequest(request('https://image.example/x', 'original'), context, options).ok).toBe(false);
    expect(convertResponsesToChatRequest({ model: 'm', input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file' }] }] }, context, options).ok).toBe(false);
  });
  it.each(['file:///x', 'data:image/png;base64,AR==', 'https://u:p@image.example/x'])('rejects unsupported image envelope %#', url => {
    expect(convertResponsesToChatRequest(request(url), context, options).ok).toBe(false);
  });
});

describe('P-RC-Q2 tools and native history', () => {
  const tool = () => ({ type: 'function' as const, name: 'lookup', description: 'Lookup', parameters: {
    type: 'object', properties: { query: { type: 'string' } },
  } });
  const call = (id: string, args = '{"query":"x"}') => ({ type: 'function_call' as const, call_id: id, name: 'lookup', arguments: args });
  const history = (): ResponsesRequest => ({ model: 'm', tools: [tool()], input: [
    { role: 'user', content: 'both' }, call('a', ' {"query":"a"} '), call('b'),
    { type: 'function_call_output', call_id: 'b', output: 'result b' },
    { type: 'function_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: '-result' }] },
    { role: 'assistant', content: 'done' },
  ] });
  it('groups contiguous parallel calls and preserves call IDs/argument bytes/result order', () => {
    const result = value(convertResponsesToChatRequest(history(), context));
    expect(result.messages).toEqual([
      { role: 'user', content: 'both' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'a', type: 'function', function: { name: 'lookup', arguments: ' {"query":"a"} ' } },
        { id: 'b', type: 'function', function: { name: 'lookup', arguments: '{"query":"x"}' } },
      ] },
      { role: 'tool', tool_call_id: 'b', content: 'result b' },
      { role: 'tool', tool_call_id: 'a', content: [{ type: 'text', text: 'a' }, { type: 'text', text: '-result' }] },
      { role: 'assistant', content: 'done' },
    ]);
    expect(parseChatRequest(result).ok).toBe(true);
  });
  it('normalizes ordinary omitted strict schemas without modifying the source', () => {
    const source = history(); const copy = structuredClone(source);
    const result = value(convertResponsesToChatRequest(source, context));
    expect(result.tools).toEqual([{ type: 'function', function: { name: 'lookup', description: 'Lookup', strict: true,
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    } }]);
    expect(source).toEqual(copy);
  });
  it('recursively normalizes nested objects/arrays while preserving explicit nullable types and enums', () => {
    const schema = { type: 'object', properties: {
      rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } },
      mode: { type: ['string', 'null'], enum: ['fast', null] },
    }, required: ['rows'] };
    const result = value(convertResponsesToChatRequest({ ...basic(), tools: [{ ...tool(), parameters: schema }] }, context));
    expect(result.tools?.[0]?.function.parameters).toEqual({ type: 'object', properties: {
      rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } },
      mode: { type: ['string', 'null'], enum: ['fast', null] },
    }, required: ['rows', 'mode'], additionalProperties: false });
  });
  it('preserves explicit false and validates explicit true instead of repairing its schema', () => {
    const lax = { ...tool(), strict: false, parameters: { ...tool().parameters, additionalProperties: true } };
    expect(value(convertResponsesToChatRequest({ ...basic(), tools: [lax] }, context)).tools?.[0]?.function)
      .toMatchObject({ strict: false, parameters: lax.parameters });
    expect(convertResponsesToChatRequest({ ...basic(), tools: [{ ...tool(), strict: true }] }, context).ok).toBe(false);
    const strict = { ...tool(), strict: true, parameters: { ...tool().parameters, required: ['query'], additionalProperties: false } };
    expect(value(convertResponsesToChatRequest({ ...basic(), tools: [strict] }, context)).tools?.[0]?.function.parameters).toEqual(strict.parameters);
  });
  it.each([
    { type: 'object', $ref: '#/$defs/item' }, { type: 'object', anyOf: [{ type: 'object' }] },
    { type: 'object', additionalProperties: true }, { type: 'object', properties: { x: { type: 'string', pattern: 'x' } } },
  ])('rejects ambiguous implicit normalization/fallback schema %#', parameters => {
    expect(convertResponsesToChatRequest({ ...basic(), tools: [{ ...tool(), parameters }] }, context).ok).toBe(false);
  });
  it.each(['auto', 'none', 'required'] as const)('preserves choice %s', tool_choice => {
    expect(value(convertResponsesToChatRequest({ ...history(), tool_choice }, context)).tool_choice).toBe(tool_choice);
  });
  it('maps named function choice but never reinterprets native tools', () => {
    const tools = [{ ...tool(), name: 'web_search' }];
    expect(value(convertResponsesToChatRequest({ ...basic(), tools, tool_choice: { type: 'function', name: 'web_search' } }, context)).tool_choice)
      .toEqual({ type: 'function', function: { name: 'web_search' } });
    expect(convertResponsesToChatRequest({ ...basic(), tools: [{ type: 'web_search' }] } as unknown as ResponsesRequest, context).ok).toBe(false);
    expect(convertResponsesToChatRequest({ ...basic(), tools, tool_choice: { type: 'function', name: 'missing' } }, context).ok).toBe(false);
  });
  it.each([true, false])('preserves parallel control %s and historical associations', parallel_tool_calls => {
    const output = value(convertResponsesToChatRequest({ ...history(), parallel_tool_calls }, context));
    expect(output.parallel_tool_calls).toBe(parallel_tool_calls);
    expect(output.messages[1]).toMatchObject({ tool_calls: [{ id: 'a' }, { id: 'b' }] });
  });
  it.each([
    [call('a')], [{ type: 'function_call_output', call_id: 'orphan', output: 'x' }],
    [call('a'), { role: 'user', content: 'interrupt' }],
    [call('a'), call('b'), { type: 'function_call_output', call_id: 'a', output: 'x' }],
    [call('a'), { type: 'function_call_output', call_id: 'a', output: 'x' }, { type: 'function_call_output', call_id: 'a', output: 'duplicate' }],
    [call('a'), { type: 'function_call_output', call_id: 'a', output: 'x' }, call('a')],
    [call('a'), call('b'), { type: 'function_call_output', call_id: 'a', output: 'x' }, call('c')],
  ].map(input => [input]))('rejects orphan/duplicate/incomplete/interleaved history %#', input => {
    expect(convertResponsesToChatRequest({ model: 'm', input } as ResponsesRequest, context).ok).toBe(false);
  });
  it.each(['', '{', '[]', 'null', '"scalar"'])('rejects malformed arguments %#', args => {
    expect(convertResponsesToChatRequest({ model: 'm', input: [call('a', args), { type: 'function_call_output', call_id: 'a', output: '' }] }, context).ok).toBe(false);
  });
  it('keeps raw argument precision and rejects unsafe ID/duplicate definition without remapping', () => {
    const args = '{"n":9007199254740993}';
    expect(value(convertResponsesToChatRequest({ model: 'm', input: [call('a', args), { type: 'function_call_output', call_id: 'a', output: '' }] }, context)).messages[0])
      .toMatchObject({ tool_calls: [{ id: 'a', function: { arguments: args } }] });
    expect(convertResponsesToChatRequest({ model: 'm', input: [call('../unsafe'), { type: 'function_call_output', call_id: '../unsafe', output: '' }] }, context).ok).toBe(false);
    expect(convertResponsesToChatRequest({ ...basic(), tools: [tool(), tool()] }, context).ok).toBe(false);
  });
});
