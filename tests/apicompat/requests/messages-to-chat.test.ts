import { describe, expect, it, vi } from 'vitest';
import { messagesToChatRequest, messagesToChatRequestAdapter, createMessagesToChatRequestAdapter } from '../../../packages/apicompat/requests/messages-to-chat.js';
import { parseChatRequest } from '../../../packages/apicompat/types/chat.js';
const base = () => ({ model: 'public', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] });
const context = { targetModel: 'chat-upstream' };
// Original synthetic fixtures, no upstream examples copied.
describe('P-MC-Q1 native text requests', () => {
  it('maps the model and exact mandatory output limit through the direct adapter', () => {
    expect(messagesToChatRequestAdapter).toMatchObject({ from: 'messages', to: 'chat' });
    const result = messagesToChatRequest(base(), context);
    expect(result).toEqual({ ok: true, value: { model: 'chat-upstream', max_completion_tokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] } });
    if (result.ok) expect(parseChatRequest(result.value).ok).toBe(true);
  });
  it('keeps system block order, whitespace, Unicode and complete adjacent-role history', () => {
    const result = messagesToChatRequest({ ...base(), system: [{ type: 'text', text: ' 第一\n' }, { type: 'text', text: '🧪' }], messages: [
      { role: 'user', content: 'one' }, { role: 'user', content: [{ type: 'text', text: 'two' }] },
      { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'text', text: 'answer' }] },
      { role: 'user', content: 'next' },
    ] }, context);
    expect(result).toMatchObject({ ok: true, value: { messages: [
      { role: 'system', content: [{ type: 'text', text: ' 第一\n' }, { type: 'text', text: '🧪' }] },
      { role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
      { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ] } });
  });
  it.each([{ cache_control: null }, { top_k: 1 }, { metadata: {} }])('rejects later features %#', extra => {
    expect(messagesToChatRequest({ ...base(), ...extra }, context).ok).toBe(false);
  });
  it.each([
    { type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'x', citations: [] },
  ])('rejects unsupported content %# without dropping fields', block => {
    expect(messagesToChatRequest({ ...base(), messages: [{ role: 'assistant', content: [block] }] }, context).ok).toBe(false);
  });
  it('rejects system cache control and does not mutate inputs', () => {
    expect(messagesToChatRequest({ ...base(), system: [{ type: 'text', text: 's', cache_control: null }] }, context).ok).toBe(false);
    const request = Object.freeze({ ...base(), system: Object.freeze([{ type: 'text', text: 's' }]) });
    const result = messagesToChatRequest(request, context);
    if (!result.ok) throw new Error('Expected conversion');
    expect(result.value.messages[0]?.content).not.toBe(request.system);
  });
  it('preserves empty text but does not invent text for empty content lists', () => {
    expect(messagesToChatRequest({ ...base(), system: '', messages: [{ role: 'user', content: '' }] }, context).ok).toBe(true);
    expect(messagesToChatRequest({ ...base(), messages: [{ role: 'user', content: [] }] }, context).ok).toBe(false);
  });
  it('rejects invalid source and target configuration', () => {
    expect(messagesToChatRequest({ ...base(), max_tokens: 0 }, context).ok).toBe(false);
    expect(messagesToChatRequest(base(), { targetModel: '' }).ok).toBe(false);
  });
});

describe('P-MC-Q3 images', () => {
  const convert = (source: unknown) => messagesToChatRequest({ ...base(), messages: [{ role: 'user', content: [{ type: 'text', text: 'before' }, { type: 'image', source }, { type: 'text', text: 'after' }] }] }, context,
    { channelCapabilities: { protocol: 'chat', features: ['image_url', 'image_base64'] } });
  it('maps HTTP images with automatic detail and no network IO', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('no fetch'); });
    try {
      const result = convert({ type: 'url', url: 'http://images.local/x?a=1#part' });
      expect(result).toMatchObject({ ok: true, value: { messages: [{ role: 'user', content: [{ text: 'before' }, { type: 'image_url', image_url: { url: 'http://images.local/x?a=1#part', detail: 'auto' } }, { text: 'after' }] }] } });
      if (result.ok) expect(parseChatRequest(result.value).ok).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])('preserves declared %s in data URL', media_type => {
    expect(convert({ type: 'base64', media_type, data: 'AQID' })).toMatchObject({ ok: true, value: { messages: [{ content: [{ text: 'before' }, { image_url: { url: `data:${media_type};base64,AQID` } }, { text: 'after' }] }] } });
  });
  it('accepts undeclared images but rejects unrepresentable tool-result and assistant mappings', () => {
    const image = { type: 'image', source: { type: 'url', url: 'https://image.example/x' } };
    const request = { ...base(), messages: [{ role: 'user', content: [image] }] };
    expect(messagesToChatRequest(request, context).ok).toBe(true);
    expect(createMessagesToChatRequestAdapter({ protocol: 'chat', features: [] }).convert(request as never, context).ok).toBe(true);
    expect(messagesToChatRequest({ ...base(), messages: [{ role: 'assistant', content: [image] }] }, context, { channelCapabilities: { protocol: 'chat', features: ['image_url'] } }).ok).toBe(false);
    expect(messagesToChatRequest({ ...base(), messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'f', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [image] }] },
    ] }, context, { channelCapabilities: { protocol: 'chat', features: ['tools', 'image_url', 'tool_result_images'] } }).ok).toBe(false);
  });
  it.each([{ type: 'base64', media_type: 'image/svg+xml', data: 'AQID' }, { type: 'base64', media_type: 'image/png', data: 'AR==' },
    { type: 'base64', media_type: 'image/png', data: '' }, { type: 'url', url: 'file:///a' }, { type: 'url', url: 'https://u:p@image.example/a' }])('rejects invalid image envelope %#', source => {
    expect(convert(source).ok).toBe(false);
  });
});

describe('P-MC-Q2 tools', () => {
  const tool = () => ({ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } });
  const input = () => ({ ...base(), tools: [tool()], messages: [
    { role: 'assistant', content: [{ type: 'text', text: 'Checking' }, { type: 'tool_use', id: 'a', name: 'lookup', input: { q: 'a' } }, { type: 'tool_use', id: 'b', name: 'lookup', input: { q: 'b' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'B' }, { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'A' }] }, { type: 'text', text: 'Next' }] },
  ] });
  it('preserves custom schemas and complete parallel IDs/results/text order', () => {
    const result = messagesToChatRequest(input(), context);
    expect(result).toMatchObject({ ok: true, value: { tools: [{ type: 'function', function: { name: 'lookup', strict: false, parameters: tool().input_schema } }], messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'Checking' }], tool_calls: [
        { id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } }, { id: 'b', type: 'function', function: { name: 'lookup', arguments: '{"q":"b"}' } },
      ] }, { role: 'tool', tool_call_id: 'b', content: 'B' }, { role: 'tool', tool_call_id: 'a', content: [{ type: 'text', text: 'A' }] },
      { role: 'user', content: [{ type: 'text', text: 'Next' }] },
    ] } });
    if (result.ok) expect(parseChatRequest(result.value).ok).toBe(true);
  });
  it.each([['auto', 'auto'], ['any', 'required'], ['none', 'none']])('maps %s choice', (type, expected) => {
    expect(messagesToChatRequest({ ...input(), tool_choice: { type } }, context)).toMatchObject({ ok: true, value: { tool_choice: expected } });
  });
  it('maps named choice, strict and parallel restrictions exactly', () => {
    const result = messagesToChatRequest({ ...input(), tools: [{ ...tool(), strict: true }], tool_choice: { type: 'tool', name: 'lookup', disable_parallel_tool_use: true } }, context);
    expect(result).toMatchObject({ ok: true, value: { tools: [{ function: { strict: true } }], tool_choice: { type: 'function', function: { name: 'lookup' } }, parallel_tool_calls: false } });
    expect(messagesToChatRequest({ ...input(), tool_choice: { type: 'tool', name: 'missing' } }, context).ok).toBe(false);
  });
  it('accepts empty regular results and split adjacent user result groups', () => {
    const result = messagesToChatRequest({ ...base(), messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'f', input: {} }, { type: 'tool_use', id: 'b', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', is_error: false }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [] }] },
    ] }, context);
    expect(result).toMatchObject({ ok: true, value: { messages: [{ tool_calls: [{ id: 'a' }, { id: 'b' }] }, { content: '' }, { content: '' }] } });
  });
  it.each(['orphan', 'duplicate', 'missing', 'error', 'text-after-tool'])('rejects nonrepresentable tool history %s', kind => {
    const messages = kind === 'orphan' ? [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'x' }] }]
      : [{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'f', input: {} }, ...(kind === 'text-after-tool' ? [{ type: 'text', text: 'late' }] : [])] },
        ...(kind === 'missing' ? [] : [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x', ...(kind === 'error' ? { is_error: true } : {}) },
          ...(kind === 'duplicate' ? [{ type: 'tool_result', tool_use_id: 'a', content: 'duplicate' }] : [])] }])];
    expect(messagesToChatRequest({ ...base(), messages }, context).ok).toBe(false);
  });
  it('rejects native tool types, duplicate names, tool cache metadata and unsafe ID/number', () => {
    for (const tools of [[{ ...tool(), type: 'web_search' }], [tool(), tool()], [{ ...tool(), cache_control: null }]]) expect(messagesToChatRequest({ ...base(), tools }, context).ok).toBe(false);
    for (const [id, input] of [['safe', { n: 9007199254740992 }], ['../bad', {}]]) expect(messagesToChatRequest({ ...base(), messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id, name: 'f', input }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] },
    ] }, context).ok).toBe(false);
  });
});

describe('P-MC-Q4 generation controls', () => {
  const configured = () => createMessagesToChatRequestAdapter({ protocol: 'chat', features: ['temperature', 'top_p', 'stop_sequences', 'streaming'], maxOutputTokens: 200 });
  it('maps the output limit, sampling, stop order and stream flag directly', () => {
    const result = configured().convert({ ...base(), max_tokens: 150, temperature: 0, top_p: 1, stop_sequences: ['END', 'STOP'], stream: true }, context);
    expect(result).toMatchObject({ ok: true, value: { max_completion_tokens: 150, temperature: 0, top_p: 1, stop: ['END', 'STOP'], stream: true } });
  });
  it('maps native sampling and stop controls while enforcing output limits', () => {
    expect(configured().convert({ ...base(), max_tokens: 201 }, context).ok).toBe(false);
    expect(messagesToChatRequest({ ...base(), temperature: 0.5 }, context).ok).toBe(true);
    expect(messagesToChatRequest({ ...base(), stop_sequences: ['END'] }, context).ok).toBe(true);
    expect(messagesToChatRequest({ ...base(), stop_sequences: [] }, context).ok).toBe(false);
  });
});

describe('P-MC-Q4-O structured output and P-MC-Q5 effort', () => {
  const schema = { type: 'object', properties: { value: { type: ['string', 'null'] } }, required: ['value'], additionalProperties: false };
  const structured = () => createMessagesToChatRequestAdapter({ protocol: 'chat', features: ['json_schema', 'reasoning_effort'], reasoningEfforts: ['low', 'medium', 'high'] });
  it('maps native output_config schema to the Chat envelope without changing the schema', () => {
    const result = structured().convert({ ...base(), output_config: { format: { type: 'json_schema', schema } } }, context);
    expect(result).toMatchObject({ ok: true, value: { response_format: { type: 'json_schema', json_schema: { name: 'output', schema, strict: true } } } });
    expect(schema).toEqual({ type: 'object', properties: { value: { type: ['string', 'null'] } }, required: ['value'], additionalProperties: false });
  });
  it('maps qualitative effort without inventing thinking budget', () => {
    expect(structured().convert({ ...base(), output_config: { effort: 'high' } }, context))
      .toMatchObject({ ok: true, value: { reasoning_effort: 'high' } });
  });
  it('rejects unsupported schema/effort and signed thinking history', () => {
    expect(structured().convert({ ...base(), output_config: { format: { type: 'json_schema', schema: { type: 'object', patternProperties: {} }, vendor: true } } }, context).ok).toBe(false);
    expect(structured().convert({ ...base(), output_config: { effort: 'max' } }, context).ok).toBe(false);
    expect(structured().convert({ ...base(), thinking: { type: 'disabled' } }, context).ok).toBe(false);
    expect(structured().convert({ ...base(), messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE', signature: 'SIGNED' }] }] }, context).ok).toBe(false);
  });
});

describe('P-MC-Q6 native cache and extension boundaries', () => {
  const configured = () => createMessagesToChatRequestAdapter({ protocol: 'chat', features: ['cache_control'], cacheTtls: ['5m', '1h'] });
  it('rejects Messages-native cache markers and unrelated extensions across protocols', () => {
    expect(configured().convert({ ...base(), cache_control: { type: 'ephemeral' } }, context).ok).toBe(false);
    expect(configured().convert({ ...base(), messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }] }, context).ok).toBe(false);
    expect(configured().convert({ ...base(), metadata: { user_id: 'u' } }, context).ok).toBe(false);
    expect(configured().convert({ ...base(), vendor_hint: true }, context).ok).toBe(false);
  });
});
