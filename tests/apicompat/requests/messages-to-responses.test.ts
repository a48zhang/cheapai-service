import { describe, expect, it, vi } from 'vitest';
import { messagesToResponsesRequest, messagesToResponsesRequestAdapter, createMessagesToResponsesRequestAdapter } from '../../../packages/apicompat/requests/messages-to-responses.js';
import type { ChannelCapabilities } from '../../../packages/apicompat/capabilities/check.js';
import { parseResponsesRequest } from '../../../packages/apicompat/types/responses.js';
const base = () => ({ model: 'public', max_tokens: 1, messages: [{ role: 'user', content: 'hello' }] });
const context = { targetModel: 'responses-upstream' };
// Original synthetic fixtures, no upstream examples or recordings copied.
describe('P-MR-Q1 direct native text history', () => {
  it('maps exact output budget/model without inventing store/parallel/verbosity options', () => {
    expect(messagesToResponsesRequestAdapter).toMatchObject({ from: 'messages', to: 'responses' });
    const result = messagesToResponsesRequest(base(), context);
    expect(result).toEqual({ ok: true, value: { model: context.targetModel, max_output_tokens: 1, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] } });
    if (result.ok) expect(parseResponsesRequest(result.value).ok).toBe(true);
  });
  it('keeps system block order and text boundaries across full adjacent-role history', () => {
    const result = messagesToResponsesRequest({ ...base(), system: [{ type: 'text', text: '第一\n' }, { type: 'text', text: '' }], messages: [
      { role: 'user', content: 'u1' }, { role: 'user', content: [{ type: 'text', text: 'u2' }] },
      { role: 'assistant', content: [{ type: 'text', text: '🧪' }, { type: 'text', text: '' }] }, { role: 'user', content: 'u3' },
    ] }, context);
    expect(result).toMatchObject({ ok: true, value: { input: [
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: '第一\n' }, { type: 'input_text', text: '' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'u1' }, { type: 'input_text', text: 'u2' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '🧪', annotations: [] }, { type: 'output_text', text: '', annotations: [] }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'u3' }] },
    ] } });
  });
  it.each([{ cache_control: null }, { top_k: 1 }, { stop_sequences: [] }, { thinking: { type: 'disabled' } }, { metadata: {} }])('rejects later controls %#', extra => {
    expect(messagesToResponsesRequest({ ...base(), ...extra }, context).ok).toBe(false);
  });
  it.each([
    { type: 'text', text: 'x', cache_control: null }, { type: 'text', text: 'x', citations: [] },
    { type: 'image', source: { type: 'url', url: 'https://image.example/x' } }, { type: 'tool_use', id: 'a', name: 'f', input: {} },
    { type: 'thinking', thinking: 'private', signature: 'signed' }, { type: 'redacted_thinking', data: 'opaque' },
  ])('rejects unsupported blocks without loss %#', block => {
    expect(messagesToResponsesRequest({ ...base(), messages: [{ role: 'assistant', content: [block] }] }, context).ok).toBe(false);
  });
  it('never drops system cache and keeps empty text without inventing list content', () => {
    expect(messagesToResponsesRequest({ ...base(), system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }] }, context).ok).toBe(false);
    expect(messagesToResponsesRequest({ ...base(), system: '', messages: [{ role: 'user', content: '' }] }, context).ok).toBe(true);
    expect(messagesToResponsesRequest({ ...base(), messages: [{ role: 'user', content: [] }] }, context).ok).toBe(false);
  });
  it('validates source and target, with fresh copied containers', () => {
    expect(messagesToResponsesRequest({ ...base(), max_tokens: 0 }, context).ok).toBe(false);
    expect(messagesToResponsesRequest(base(), { targetModel: '' }).ok).toBe(false);
    const source = { ...base(), system: [{ type: 'text', text: 's' }] };
    const original = structuredClone(source); const result = messagesToResponsesRequest(source, context);
    expect(source).toEqual(original);
    if (!result.ok) throw new Error('Expected conversion');
    expect(result.value.input).not.toBe(source.messages);
  });
});

describe('P-MR-Q3 image transport', () => {
  const policy: ChannelCapabilities = { protocol: 'responses', features: ['tools', 'image_url', 'image_base64', 'tool_result_images'] };
  const image = (source: unknown) => ({ type: 'image', source });
  const convert = (source: unknown) => messagesToResponsesRequest({ ...base(), messages: [{ role: 'user', content: [{ type: 'text', text: 'before' }, image(source), { type: 'text', text: 'after' }] }] }, context, { channelCapabilities: policy });
  it('keeps URL/text block order and never fetches images', () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('no fetch'); });
    try {
      const result = convert({ type: 'url', url: 'http://images.local/x?a=1#part' });
      expect(result).toMatchObject({ ok: true, value: { input: [{ content: [{ text: 'before' }, { type: 'input_image', image_url: 'http://images.local/x?a=1#part', detail: 'auto' }, { text: 'after' }] }] } });
      if (result.ok) expect(parseResponsesRequest(result.value).ok).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])('preserves %s base64 MIME and bytes', media_type => {
    expect(convert({ type: 'base64', media_type, data: 'AQID' })).toMatchObject({ ok: true, value: { input: [{ content: [{ text: 'before' }, { image_url: `data:${media_type};base64,AQID` }, { text: 'after' }] }] } });
  });
  it('supports mixed text/images in tool results without capability declarations', () => {
    const request = { ...base(), messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'result' }, image({ type: 'base64', media_type: 'image/png', data: 'AQID' })] }] },
    ] };
    const result = messagesToResponsesRequest(request, context, { channelCapabilities: policy });
    expect(result).toMatchObject({ ok: true, value: { input: [{ type: 'function_call', call_id: 'a' }, { type: 'function_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'result' }, { type: 'input_image', image_url: 'data:image/png;base64,AQID' }] }] } });
    if (result.ok) expect(parseResponsesRequest(result.value).ok).toBe(true);
    expect(messagesToResponsesRequest(request, context, { channelCapabilities: { protocol: 'responses', features: ['tools', 'image_base64'] } }).ok).toBe(true);
  });
  it('accepts undeclared image transport but rejects assistant images', () => {
    const request = { ...base(), messages: [{ role: 'user', content: [image({ type: 'url', url: 'https://image.example/x' })] }] };
    expect(messagesToResponsesRequest(request, context).ok).toBe(true);
    expect(createMessagesToResponsesRequestAdapter({ protocol: 'responses', features: [] }).convert(request as never, context).ok).toBe(true);
    expect(messagesToResponsesRequest({ ...request, messages: [{ role: 'assistant', content: request.messages[0]!.content }] }, context, { channelCapabilities: policy }).ok).toBe(false);
  });
  it.each([{ type: 'base64', media_type: 'image/svg+xml', data: 'AQID' }, { type: 'base64', media_type: 'image/png', data: 'AR==' },
    { type: 'base64', media_type: 'image/png', data: '' }])('rejects unsupported image source %#', source => {
    expect(convert(source).ok).toBe(false);
  });
});

describe('P-MR-Q2 native tool items', () => {
  const tool = () => ({ name: 'web_search', input_schema: { type: 'object', properties: { q: { type: 'string' } } } });
  const source = () => ({ ...base(), tools: [tool()], messages: [
    { role: 'assistant', content: [{ type: 'text', text: 'first' }, { type: 'tool_use', id: 'a', name: 'web_search', input: { q: 'a' } },
      { type: 'text', text: 'between' }, { type: 'tool_use', id: 'b', name: 'web_search', input: { q: 'b' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'B' }, { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'A' }] }, { type: 'text', text: 'next' }] },
  ] });
  it('preserves interleaved assistant blocks, parallel IDs and inverse result order without Chat pivot', () => {
    const result = messagesToResponsesRequest(source(), context);
    expect(result).toMatchObject({ ok: true, value: { tools: [{ type: 'function', name: 'web_search', strict: false }], input: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first', annotations: [] }] },
      { type: 'function_call', call_id: 'a', name: 'web_search', arguments: '{"q":"a"}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'between', annotations: [] }] },
      { type: 'function_call', call_id: 'b', name: 'web_search', arguments: '{"q":"b"}' },
      { type: 'function_call_output', call_id: 'b', output: 'B' },
      { type: 'function_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'A' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
    ] } });
    if (result.ok) expect(parseResponsesRequest(result.value).ok).toBe(true);
  });
  it.each([['auto', 'auto'], ['any', 'required'], ['none', 'none']])('maps choice %s', (type, expected) => {
    expect(messagesToResponsesRequest({ ...source(), tool_choice: { type } }, context)).toMatchObject({ ok: true, value: { tool_choice: expected } });
  });
  it('maps named choice/strict/parallel flags and refuses built-in reinterpretation', () => {
    expect(messagesToResponsesRequest({ ...source(), tools: [{ ...tool(), strict: true }], tool_choice: { type: 'tool', name: 'web_search', disable_parallel_tool_use: true } }, context))
      .toMatchObject({ ok: true, value: { tools: [{ type: 'function', strict: true }], tool_choice: { type: 'function', name: 'web_search' }, parallel_tool_calls: false } });
    expect(messagesToResponsesRequest({ ...base(), tools: [{ ...tool(), type: 'web_search' }] }, context).ok).toBe(false);
  });
  it.each(['orphan', 'duplicate', 'missing', 'error', 'unknown-choice'])('rejects unsupported associations %s', kind => {
    const source = { ...base(), messages: kind === 'orphan' ? [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] }]
      : [{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'f', input: {} }] }, ...(kind === 'missing' ? [] : [{ role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'x', ...(kind === 'error' ? { is_error: true } : {}) },
        ...(kind === 'duplicate' ? [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] : []),
      ] }])], ...(kind === 'unknown-choice' ? { tool_choice: { type: 'tool', name: 'missing' } } : {}) };
    expect(messagesToResponsesRequest(source, context).ok).toBe(false);
  });
  it('supports empty regular results and keeps JSON parameters exact within the safe numeric range', () => {
    const result = messagesToResponsesRequest({ ...base(), messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'f', input: { values: [1, true, null] } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', is_error: false }] },
    ] }, context);
    expect(result).toMatchObject({ ok: true, value: { input: [{ arguments: '{"values":[1,true,null]}' }, { output: '' }] } });
  });
});

describe('P-MR-Q4 generation controls', () => {
  const configured = () => createMessagesToResponsesRequestAdapter({
    protocol: 'responses', features: ['temperature', 'top_p', 'streaming'], maxOutputTokens: 200,
  });
  it('maps output limit, sampling and stream without fabricating defaults', () => {
    const result = configured().convert({ ...base(), max_tokens: 150, temperature: 0, top_p: 1, stream: true }, context);
    expect(result).toMatchObject({ ok: true, value: { max_output_tokens: 150, temperature: 0, top_p: 1, stream: true } });
  });
  it('maps undeclared sampling while rejecting output limits and unrepresentable stop controls', () => {
    expect(configured().convert({ ...base(), max_tokens: 201 }, context).ok).toBe(false);
    expect(messagesToResponsesRequest({ ...base(), temperature: 0.5 }, context).ok).toBe(true);
    expect(configured().convert({ ...base(), stop_sequences: ['END'] }, context).ok).toBe(false);
    expect(configured().convert({ ...base(), stop_sequences: [] }, context).ok).toBe(false);
  });
});

describe('P-MR-Q4-O structured output and P-MR-Q5 effort', () => {
  const schema = { type: 'object', properties: { value: { type: ['string', 'null'] } }, required: ['value'], additionalProperties: false };
  const structured = () => createMessagesToResponsesRequestAdapter({
    protocol: 'responses', features: ['json_schema', 'reasoning_effort'], reasoningEfforts: ['low', 'medium', 'high'],
  });
  it('maps native output_config schema to Responses text.format without changing the schema', () => {
    const result = structured().convert({ ...base(), output_config: { format: { type: 'json_schema', schema } } }, context);
    expect(result).toMatchObject({ ok: true, value: { text: { format: { type: 'json_schema', name: 'output', schema, strict: true } } } });
    expect(schema).toEqual({ type: 'object', properties: { value: { type: ['string', 'null'] } }, required: ['value'], additionalProperties: false });
  });
  it.each(['low', 'medium', 'high'])('maps qualitative effort %s without synthesizing thinking', effort => {
    expect(structured().convert({ ...base(), output_config: { effort } }, context))
      .toMatchObject({ ok: true, value: { reasoning: { effort } } });
  });
  it('rejects unsupported schema/effort and native thinking modes', () => {
    expect(structured().convert({ ...base(), output_config: { format: { type: 'json_schema', schema: { type: 'object', patternProperties: {} }, vendor: true } } }, context).ok).toBe(false);
    expect(structured().convert({ ...base(), output_config: { effort: 'max' } }, context).ok).toBe(false);
    expect(structured().convert({ ...base(), thinking: { type: 'adaptive' } }, context).ok).toBe(false);
  });
});

describe('P-MR-Q6 native cache and extension boundaries', () => {
  const configured = () => createMessagesToResponsesRequestAdapter({
    protocol: 'responses', features: ['cache_control'], cacheTtls: ['5m', '1h'],
  });
  it('rejects Messages-native cache markers and unrelated extensions across protocols', () => {
    expect(configured().convert({ ...base(), cache_control: { type: 'ephemeral' } }, context).ok).toBe(false);
    expect(configured().convert({ ...base(), messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }] }, context).ok).toBe(false);
    expect(configured().convert({ ...base(), metadata: { user_id: 'u' } }, context).ok).toBe(false);
    expect(configured().convert({ ...base(), vendor_hint: true }, context).ok).toBe(false);
  });
});
