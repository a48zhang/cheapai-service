import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { CapabilityFeature } from '../../../packages/apicompat/capabilities/check.js';
import { createChatToMessagesRequestAdapter } from '../../../packages/apicompat/requests/chat-to-messages.js';
import type { RequestAdapter } from '../../../packages/apicompat/types/adapter.js';
import type { ChatMessage, ChatRequest } from '../../../packages/apicompat/types/chat.js';
import { parseMessagesRequest } from '../../../packages/apicompat/types/messages.js';
import type { MessagesRequest } from '../../../packages/apicompat/types/messages.js';
import type { ConversionResult } from '../../../packages/apicompat/types/shared.js';

// Original synthetic histories, not upstream-derived or real provider fixtures.
function value<T>(result: ConversionResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
const make = () => value(createChatToMessagesRequestAdapter({ maxTokens: 512 }));
const basic = (): ChatRequest => ({ model: 'public-model', messages: [{ role: 'user', content: 'hello' }] });
const context = { targetModel: 'configured-upstream-model' };

describe('Chat→Messages text request milestone', () => {
  it('implements the direct adapter contract and uses the configured target model/budget', () => {
    const adapter = make();
    expectTypeOf(adapter).toEqualTypeOf<RequestAdapter<ChatRequest, MessagesRequest, 'chat', 'messages'>>();
    expect(adapter).toMatchObject({ from: 'chat', to: 'messages' });
    const result = value(adapter.convert(basic(), context));
    expect(result).toEqual({ model: context.targetModel, max_tokens: 512, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
    expect(parseMessagesRequest(result).ok).toBe(true);
  });

  it.each(['system', 'developer'] as const)('retains ordered %s instructions without invented labels or delimiters', role => {
    const request: ChatRequest = { model: 'm', messages: [
      { role, content: 'first\n' },
      { role, content: [{ type: 'text', text: 'second' }, { type: 'text', text: ' third' }] },
      { role: 'user', content: 'question' },
    ] };
    const output = value(make().convert(request, context));
    expect(output.system).toEqual([{ type: 'text', text: 'first\n' }, { type: 'text', text: 'second' }, { type: 'text', text: ' third' }]);
    expect(output.messages).toHaveLength(1);
    expect(parseMessagesRequest(output).ok).toBe(true);
  });

  it('keeps complete text history ordered and merges only adjacent equal roles', () => {
    const request: ChatRequest = { model: 'm', messages: [
      { role: 'user', content: 'u0' },
      { role: 'user', content: [{ type: 'text', text: 'u1' }, { type: 'text', text: 'u2' }] },
      { role: 'assistant', content: 'a0' },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u4' },
    ] };
    expect(value(make().convert(request, context)).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'u0' }, { type: 'text', text: 'u1' }, { type: 'text', text: 'u2' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a0' }, { type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'u3' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      { role: 'user', content: [{ type: 'text', text: 'u4' }] },
    ]);
  });

  it('does not mutate inputs or retain aliases to input content blocks', () => {
    const block = Object.freeze({ type: 'text' as const, text: 'original' });
    const request = Object.freeze({ model: 'm', messages: Object.freeze([Object.freeze({ role: 'user' as const, content: Object.freeze([block]) })]) });
    const output = value(make().convert(request, Object.freeze(context)));
    expect(output.messages[0]?.content).not.toBe(request.messages[0]?.content);
    expect(output.messages[0]?.content[0]).not.toBe(block);
    expect(JSON.stringify(request)).toContain('original');
  });

  it.each([
    ['system', 'developer'], ['developer', 'system'],
  ] as const)('rejects collapsing %s/%s priorities into one tier', (first, second) => {
    const messages: ChatMessage[] = [{ role: first, content: 'higher/lower' }, { role: second, content: 'different tier' }, { role: 'user', content: 'x' }];
    expect(make().convert({ model: 'm', messages }, context)).toMatchObject({ ok: false, error: { kind: 'unsupported_feature', code: 'no_protocol_mapping', param: '$.messages' } });
  });

  it.each(['system', 'developer'] as const)('rejects hoisting interleaved %s instructions', role => {
    expect(make().convert({ model: 'm', messages: [{ role: 'user', content: 'earlier' }, { role, content: 'later' }, { role: 'user', content: 'next' }] }, context))
      .toMatchObject({ ok: false, error: { code: 'interleaved_instruction_not_representable' } });
  });

  it.each([
    { tool_choice: 'auto' }, { parallel_tool_calls: false },
    { seed: 0 }, { frequency_penalty: 0 }, { presence_penalty: 0 },
    { service_tier: 'auto' },
    { user: 'identity' }, { metadata: {} }, { vendor_option: { enabled: true } },
  ])('explicitly rejects unimplemented request feature %j', extra => {
    expect(make().convert({ ...basic(), ...extra } as ChatRequest, context))
      .toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
  });

  it.each([
    { role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] },
    { role: 'assistant', refusal: 'no' },
    { role: 'user', content: 'named', name: 'alice' },
  ])('rejects advanced message/block feature %# instead of dropping it', message => {
    expect(make().convert({ model: 'm', messages: [message as ChatMessage] }, context))
      .toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
  });

  it('requires conversational content after instructions', () => {
    expect(make().convert({ model: 'm', messages: [{ role: 'developer', content: 'only instructions' }] }, context))
      .toMatchObject({ ok: false, error: { code: 'messages_conversation_required' } });
  });

  it('reports invalid structure before conversion without reflecting user content', () => {
    const invalid = { model: 'm', messages: [{ role: 'user', content: { secret: 'private-input' } }] } as unknown as ChatRequest;
    const result = make().convert(invalid, context);
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
    expect(JSON.stringify(result)).not.toContain('private-input');
    expect(make().convert(basic(), { targetModel: ' ' })).toMatchObject({ ok: false, error: { code: 'invalid_target_model' } });
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('requires an explicit valid output budget %s', maxTokens => {
    expect(createChatToMessagesRequestAdapter({ maxTokens }).ok).toBe(false);
  });

  it('snapshots model-policy budget and has no state across conversions', () => {
    const options = { maxTokens: 7 };
    const adapter = value(createChatToMessagesRequestAdapter(options));
    options.maxTokens = 99;
    const first = value(adapter.convert({ model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'a' }] }, context));
    const second = value(adapter.convert(basic(), { targetModel: 'other' }));
    expect(first.max_tokens).toBe(7);
    expect(second.max_tokens).toBe(7);
    expect(second.model).toBe('other');
    expect(second).not.toHaveProperty('system');
  });
});

describe('P-CM-Q6 reviewed cache markers and extensions', () => {
  const configured = () => value(createChatToMessagesRequestAdapter({ maxTokens: 512, channelCapabilities: {
    protocol: 'messages', features: ['cache_control', 'tools', 'strict_tools', 'image_url'], cacheTtls: ['1h', '5m'], maxOutputTokens: 1024,
  } }));
  it('maps request, tool and system/user block cache markers into native positions', () => {
    const input: ChatRequest = { model: 'm', cache_control: { type: 'ephemeral', ttl: '5m' },
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } }, cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [
        { role: 'system', content: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        { role: 'user', content: [{ type: 'text', text: 'user', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
      ] };
    const result = configured().convert(input, context);
    expect(result).toMatchObject({ ok: true, value: {
      cache_control: { type: 'ephemeral', ttl: '5m' }, tools: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }],
      system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'user', cache_control: { type: 'ephemeral', ttl: '5m' } }] }],
    } });
    if (result.ok) {
      expect(parseMessagesRequest(result.value).ok).toBe(true);
      expect(result.value.cache_control).not.toBe(input.cache_control);
    }
  });
  it('preserves omitted/default TTL and explicit null without inventing a marker', () => {
    expect(configured().convert({ ...basic(), cache_control: { type: 'ephemeral' } }, context)).toMatchObject({ ok: true, value: { cache_control: { type: 'ephemeral' } } });
    const result = make().convert({ ...basic(), cache_control: null }, context);
    expect(result).toMatchObject({ ok: true, value: { cache_control: null } });
  });
  it('keeps image-block cache metadata without fetching or moving it to the text block', () => {
    const result = configured().convert({ model: 'm', messages: [{ role: 'user', content: [
      { type: 'text', text: 'before' }, { type: 'image_url', image_url: { url: 'https://image.example/x' }, cache_control: { type: 'ephemeral' } },
    ] }] }, context);
    expect(result).toMatchObject({ ok: true, value: { messages: [{ content: [{ type: 'text', text: 'before' }, { type: 'image', cache_control: { type: 'ephemeral' } }] }] } });
  });
  it('preserves requested cache TTL without administrator declarations', () => {
    const input = { ...basic(), cache_control: { type: 'ephemeral', ttl: '1h' } };
    expect(make().convert(input, context).ok).toBe(true);
    const onlyShort = value(createChatToMessagesRequestAdapter({ maxTokens: 512, channelCapabilities: { protocol: 'messages', features: ['cache_control'], cacheTtls: ['5m'] } }));
    expect(onlyShort.convert(input, context).ok).toBe(true);
  });
  it('rejects unknown cache fields without reflecting their values', () => {
    const result = configured().convert({ ...basic(), cache_control: { type: 'ephemeral', api_key: 'SECRET' } }, context);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('rejects unsupported marker placements/unknown cache extensions', () => {
    expect(configured().convert({ ...basic(), vendor_cache: { type: 'ephemeral' } }, context).ok).toBe(false);
    expect(configured().convert({ model: 'm', messages: [{ role: 'user', content: 'x', cache_control: { type: 'ephemeral' } }] }, context).ok).toBe(false);
    expect(configured().convert({ ...basic(), tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' }, cache_control: { type: 'ephemeral' } } }] }, context).ok).toBe(false);
  });
  it('rejects too many markers and short-before-long TTL order without silently changing TTL', () => {
    expect(configured().convert({ model: 'm', messages: [{ role: 'system', content: Array.from({ length: 5 }, () => ({ type: 'text' as const, text: 'x', cache_control: { type: 'ephemeral' } })) }, ...basic().messages] }, context).ok).toBe(false);
    const reversed = configured().convert({ model: 'm', messages: [
      { role: 'system', content: [{ type: 'text', text: 'short', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text', text: 'long', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ] }, context);
    expect(reversed).toMatchObject({ ok: false, error: { code: 'invalid_cache_ttl_order' } });
  });
  it('rejects automatic/last explicit marker TTL mismatch', () => {
    expect(configured().convert({ model: 'm', cache_control: { type: 'ephemeral', ttl: '5m' }, messages: [
      { role: 'user', content: [{ type: 'text', text: 'long', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ] }, context)).toMatchObject({ ok: false, error: { code: 'invalid_cache_ttl_order' } });
  });
  it('maps explicitly supported strict tools without changing their schema', () => {
    const parameters = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false };
    expect(configured().convert({ ...basic(), tools: [{ type: 'function', function: { name: 'f', parameters, strict: true } }] }, context))
      .toMatchObject({ ok: true, value: { tools: [{ name: 'f', input_schema: parameters, strict: true }] } });
  });
});

describe('P-CM-Q5 qualitative effort', () => {
  const adapter = () => value(createChatToMessagesRequestAdapter({ maxTokens: 512, channelCapabilities: {
    protocol: 'messages', features: ['reasoning_effort', 'json_schema'], reasoningEfforts: ['low', 'medium', 'high'], maxOutputTokens: 1024,
  } }));
  it('preserves configured effort without invented thinking budget/mode', () => {
    const reasoning_effort = 'high';
    const result = adapter().convert({ ...basic(), reasoning_effort }, context);
    expect(result).toMatchObject({ ok: true, value: { max_tokens: 512, output_config: { effort: reasoning_effort } } });
    if (result.ok) { expect(result.value).not.toHaveProperty('thinking'); expect(parseMessagesRequest(result.value).ok).toBe(true); }
  });
  it('combines format and effort without overwriting either constraint', () => {
    const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
    expect(adapter().convert({ ...basic(), reasoning_effort: 'medium', response_format: { type: 'json_schema', json_schema: { name: 'out', schema, strict: true } } }, context))
      .toMatchObject({ ok: true, value: { output_config: { effort: 'medium', format: { type: 'json_schema', schema } } } });
  });
  it.each(['max', 'vendor'])('does not guess CM effort mapping for %s', reasoning_effort => {
    expect(adapter().convert({ ...basic(), reasoning_effort }, context).ok).toBe(false);
  });
  it('maps native effort without declarations and leaves null unspecified', () => {
    expect(make().convert({ ...basic(), reasoning_effort: 'high' }, context).ok).toBe(true);
    const result = make().convert({ ...basic(), reasoning_effort: null }, context);
    expect(result.ok).toBe(true); if (result.ok) expect(result.value).not.toHaveProperty('output_config');
  });
  it.each([{ reasoning_content: 'PRIVATE' }, { reasoning: 'PRIVATE' }, { thinking: 'PRIVATE', signature: 'PRIVATE' }])('does not forge signed/private thinking history %#', extra => {
    const result = adapter().convert({ model: 'm', messages: [{ role: 'assistant', content: 'visible', ...extra }] }, context);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});

describe('P-CM-Q4-O native output schema', () => {
  const adapter = () => value(createChatToMessagesRequestAdapter({ maxTokens: 128, channelCapabilities: { protocol: 'messages', features: ['json_schema'], maxOutputTokens: 256 } }));
  const schema = () => ({ type: 'object', properties: { value: { type: ['string', 'null'] } }, required: ['value'], additionalProperties: false });
  it('maps strict JSON schema directly to output_config.format and preserves description', () => {
    const input = { ...basic(), response_format: { type: 'json_schema' as const, json_schema: { name: 'label', schema: schema(), strict: true, description: 'Requested output' } } };
    const result = adapter().convert(input, context);
    expect(result).toMatchObject({ ok: true, value: { output_config: { format: { type: 'json_schema', schema: { ...schema(), description: 'Requested output' } } } } });
    if (result.ok) expect(parseMessagesRequest(result.value).ok).toBe(true);
    expect(input.response_format.json_schema.schema).not.toHaveProperty('description');
  });
  it('allows explicit text without imposing a JSON constraint', () => {
    const result = make().convert({ ...basic(), response_format: { type: 'text' } }, context);
    expect(result.ok).toBe(true); if (result.ok) expect(result.value).not.toHaveProperty('output_config');
  });
  it.each([false, null, undefined])('does not strengthen advisory strict=%s into native constrained decoding', strict => {
    expect(adapter().convert({ ...basic(), response_format: { type: 'json_schema', json_schema: { name: 'x', schema: schema(), ...(strict === undefined ? {} : { strict }) } } }, context).ok).toBe(false);
  });
  it('rejects unrepresentable schema constraints while allowing undeclared schema support', () => {
    expect(adapter().convert({ ...basic(), response_format: { type: 'json_object' } }, context).ok).toBe(false);
    for (const extra of [{ patternProperties: {} }, { description: 'different' }]) expect(adapter().convert({ ...basic(), response_format: { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: { ...schema(), ...extra }, description: 'wrapper' } } }, context).ok).toBe(false);
    expect(make().convert({ ...basic(), response_format: { type: 'json_schema', json_schema: { name: 'x', strict: true, schema: schema() } } }, context).ok).toBe(true);
  });
});

describe('P-CM-Q4 generation controls', () => {
  const configured = () => value(createChatToMessagesRequestAdapter({ maxTokens: 100, channelCapabilities: {
    protocol: 'messages', features: ['temperature', 'top_p', 'stop_sequences', 'streaming'], maxOutputTokens: 200,
  } }));
  it.each(['max_tokens', 'max_completion_tokens'])('maps %s exactly without clamping or replacing the explicit limit', field => {
    expect(configured().convert({ ...basic(), [field]: 150 }, context)).toMatchObject({ ok: true, value: { max_tokens: 150 } });
    expect(configured().convert({ ...basic(), [field]: 201 }, context).ok).toBe(false);
  });
  it('uses configured fallback only for missing/null limits and rejects two explicit limits', () => {
    expect(configured().convert({ ...basic(), max_tokens: null, max_completion_tokens: null }, context)).toMatchObject({ ok: true, value: { max_tokens: 100 } });
    expect(configured().convert({ ...basic(), max_tokens: 10, max_completion_tokens: 10 }, context)).toMatchObject({ ok: false, error: { code: 'conflicting_output_limits' } });
  });
  it('preserves representable sampling, stop order and stream booleans', () => {
    expect(configured().convert({ ...basic(), temperature: 0, top_p: 1, stop: ['END', 'STOP'], stream: true }, context))
      .toMatchObject({ ok: true, value: { temperature: 0, top_p: 1, stop_sequences: ['END', 'STOP'], stream: true } });
    expect(configured().convert({ ...basic(), stop: 'END' }, context)).toMatchObject({ ok: true, value: { stop_sequences: ['END'] } });
    expect(make().convert({ ...basic(), stream: false, n: 1, temperature: null, top_p: null, stop: null }, context).ok).toBe(true);
  });
  it('accepts undeclared sampling but rejects incompatible temperature and multiple choices', () => {
    expect(configured().convert({ ...basic(), temperature: 1.1 }, context)).toMatchObject({ ok: false, error: { code: 'parameter_not_representable' } });
    expect(make().convert({ ...basic(), temperature: 0.5 }, context).ok).toBe(true);
    expect(configured().convert({ ...basic(), n: 2 }, context).ok).toBe(false);
  });
});

describe('CM-STREAM-OPTIONS downstream usage preference', () => {
  const configured = () => value(createChatToMessagesRequestAdapter({ maxTokens: 128, channelCapabilities: {
    protocol: 'messages', features: ['streaming'], maxOutputTokens: 256,
  } }));
  it.each([true, false])('accepts include_usage=%s while omitting stream_options upstream', include_usage => {
    const result = configured().convert({ ...basic(), stream: true, stream_options: { include_usage } }, context);
    expect(result).toMatchObject({ ok: true, value: { stream: true } });
    if (result.ok) expect(result.value).not.toHaveProperty('stream_options');
  });
  it('rejects null, unknown nested options and non-streaming usage preferences', () => {
    expect(configured().convert({ ...basic(), stream_options: null }, context).ok).toBe(false);
    expect(configured().convert({ ...basic(), stream: true, stream_options: { include_usage: true, vendor: true } }, context).ok).toBe(false);
    expect(configured().convert({ ...basic(), stream: false, stream_options: { include_usage: true } }, context).ok).toBe(false);
  });
});

describe('P-CM-Q3 image conversion with explicit model capabilities', () => {
  const imageRequest = (url: string, detail?: 'auto' | 'low' | 'high'): ChatRequest => ({ model: 'public', messages: [
    { role: 'user', content: [{ type: 'text', text: 'before' }, { type: 'image_url', image_url: { url, ...(detail === undefined ? {} : { detail }) } }, { type: 'text', text: 'after' }] },
  ] });
  const images = (features: readonly CapabilityFeature[] = ['image_url', 'image_base64']) => value(createChatToMessagesRequestAdapter({
    maxTokens: 512, channelCapabilities: { protocol: 'messages', features, maxOutputTokens: 1024 },
  }));

  it('preserves HTTPS URL and text order without fetching or guessing a media type', () => {
    const url = 'http://images.local/path/photo?format=original#part';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('must not fetch'); });
    try {
      const output = value(images().convert(imageRequest(url), context));
      expect(output.messages[0]?.content).toEqual([
        { type: 'text', text: 'before' }, { type: 'image', source: { type: 'url', url } }, { type: 'text', text: 'after' },
      ]);
      expect(parseMessagesRequest(output).ok).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  it.each([
    ['image/png', 'iVBORw0KGgo='], ['image/jpeg', '/9j/2Q=='], ['image/gif', 'R0lGODlh'], ['image/webp', 'UklGRgAAAABXRUJQ'],
  ])('preserves declared %s and canonical base64 data', (media_type, data) => {
    // Synthetic signature-sized byte samples, not provider-validated full images.
    const output = value(images().convert(imageRequest(`data:${media_type};base64,${data}`), context));
    expect(output.messages[0]?.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type, data } });
    expect(parseMessagesRequest(output).ok).toBe(true);
  });

  it('allows automatic detail but refuses fixed low/high detail even if flagged by the channel', () => {
    expect(images().convert(imageRequest('https://image.example/p.png', 'auto'), context).ok).toBe(true);
    for (const detail of ['low', 'high'] as const) expect(images(['image_url', 'image_detail']).convert(imageRequest('https://image.example/p.png', detail), context))
      .toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
  });

  it('allows undeclared image transports while enforcing the configured output budget', () => {
    expect(make().convert(imageRequest('https://image.example/p.png'), context)).toMatchObject({ ok: true });
    expect(images(['image_base64']).convert(imageRequest('https://image.example/p.png'), context)).toMatchObject({ ok: true });
    expect(images(['image_url']).convert(imageRequest('data:image/png;base64,AQID'), context)).toMatchObject({ ok: true });
    const capped = value(createChatToMessagesRequestAdapter({ maxTokens: 512, channelCapabilities: { protocol: 'messages', features: ['image_url'], maxOutputTokens: 100 } }));
    expect(capped.convert(imageRequest('https://image.example/p.png'), context)).toMatchObject({ ok: false, error: { code: 'output_limit_exceeded' } });
    expect(createChatToMessagesRequestAdapter({ maxTokens: 512, channelCapabilities: { protocol: 'chat', features: ['image_url'] } }).ok).toBe(false);
  });

  it.each(['data:image/svg+xml;base64,AQID', 'data:application/pdf;base64,AQID', 'data:image/png;base64,', 'data:image/png;base64,AQ',
    'data:image/png;base64,AR==', 'data:image/png;base64,A QID', 'data:image/png,percent%20encoded', 'data:image/jpg;base64,AQID'])('rejects unsupported MIME or malformed data envelope %#', url => {
    expect(images().convert(imageRequest(url), context).ok).toBe(false);
  });

  it.each(['file:///image.png', 'javascript:alert(1)', '/relative.png',
    'https://user:secret@image.example/p.png', 'https://image.example/a b'])('rejects nonrepresentable URL %# without fetching', url => {
    expect(images().convert(imageRequest(url), context).ok).toBe(false);
  });

  it('does not drop source extensions or accept images in unsupported Chat roles', () => {
    const extra: ChatRequest = { model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://image.example/x' }, vendor: true }] }] };
    expect(images().convert(extra, context).ok).toBe(false);
    const invalid = { model: 'm', messages: [{ role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'https://image.example/x' } }] }] } as unknown as ChatRequest;
    expect(images().convert(invalid, context).ok).toBe(false);
  });

  it('preserves images alongside a complete tool round when all P10 features are declared', () => {
    const request: ChatRequest = { ...imageRequest('https://image.example/x'), messages: [
      ...imageRequest('https://image.example/x').messages,
      { role: 'assistant', tool_calls: [{ id: 'call_image', type: 'function', function: { name: 'describe', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_image', content: 'image result' },
    ] };
    const output = value(images(['image_url', 'tools']).convert(request, context));
    expect(output.messages[0]?.content[1]).toMatchObject({ type: 'image' });
    expect(output.messages[1]?.content[0]).toMatchObject({ type: 'tool_use', id: 'call_image' });
    expect(output.messages[2]?.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_image' });
  });
});

describe('Chat→Messages tools and complete tool history', () => {
  const definition = () => ({ type: 'function' as const, function: { name: 'lookup', description: 'Find a value', parameters: {
    type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
  } } });
  const call = (id: string, argumentsText = '{"query":"test"}') => ({ id, type: 'function' as const, function: { name: 'lookup', arguments: argumentsText } });
  const request = (): ChatRequest => ({ model: 'm', tools: [definition()], messages: [
    { role: 'user', content: 'look up both' },
    { role: 'assistant', content: 'Checking.', tool_calls: [call('call_a'), call('call_b', '{"query":"second"}')] },
    { role: 'tool', tool_call_id: 'call_b', content: 'second result' },
    { role: 'tool', tool_call_id: 'call_a', content: [{ type: 'text', text: 'first' }, { type: 'text', text: ' result' }] },
    { role: 'assistant', content: 'Both found.' },
    { role: 'user', content: 'next' },
  ] });

  it('preserves definitions, parallel call IDs/arguments and original result order', () => {
    const input = request();
    const output = value(make().convert(input, context));
    expect(output.tools).toEqual([{ name: 'lookup', description: 'Find a value', input_schema: definition().function.parameters }]);
    expect(output.messages[1]).toEqual({ role: 'assistant', content: [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call_a', name: 'lookup', input: { query: 'test' } },
      { type: 'tool_use', id: 'call_b', name: 'lookup', input: { query: 'second' } },
    ] });
    expect(output.messages[2]).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_b', content: 'second result' },
      { type: 'tool_result', tool_use_id: 'call_a', content: [{ type: 'text', text: 'first' }, { type: 'text', text: ' result' }] },
    ] });
    expect(parseMessagesRequest(output).ok).toBe(true);
    expect(output.tools?.[0]?.input_schema).not.toBe(input.tools?.[0]?.function.parameters);
  });

  it.each([
    ['auto', { type: 'auto' }], ['none', { type: 'none' }], ['required', { type: 'any' }],
    [{ type: 'function', function: { name: 'lookup' } }, { type: 'tool', name: 'lookup' }],
  ] as const)('maps tool choice %j', (choice, expected) => {
    expect(value(make().convert({ ...request(), tool_choice: choice }, context)).tool_choice).toEqual(expected);
  });

  it.each([true, false])('preserves parallel_tool_calls=%s without changing recorded history', parallel_tool_calls => {
    const output = value(make().convert({ ...request(), parallel_tool_calls }, context));
    expect(output.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: !parallel_tool_calls });
    expect(output.messages[1]?.content).toHaveLength(3);
    expect(value(make().convert({ ...request(), tool_choice: 'required', parallel_tool_calls }, context)).tool_choice)
      .toEqual({ type: 'any', disable_parallel_tool_use: !parallel_tool_calls });
  });

  it('supports none with no definitions and keeps explicit empty definitions', () => {
    const output = value(make().convert({ ...basic(), tools: [], tool_choice: 'none', parallel_tool_calls: false }, context));
    expect(output.tools).toEqual([]);
    expect(output.tool_choice).toEqual({ type: 'none' });
  });

  it('supports tool-only assistant turns, empty result strings, and adjacent follow-up user text', () => {
    const input: ChatRequest = { model: 'm', messages: [
      { role: 'assistant', content: null, tool_calls: [call('old_call', '{}')] },
      { role: 'tool', tool_call_id: 'old_call', content: '' },
      { role: 'user', content: 'continue' },
    ] };
    expect(value(make().convert(input, context)).messages).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'old_call', name: 'lookup', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old_call', content: '' }, { type: 'text', text: 'continue' }] },
    ]);
  });

  it.each(['', '{', '[]', 'null', '1', '"text"', '{"n":1e999}', '{"n":9007199254740993}', '{"q":NaN}', ' '.repeat(1_048_577)])('rejects malformed/nonobject/oversize tool arguments %#', argumentsText => {
    const input: ChatRequest = { model: 'm', messages: [
      { role: 'assistant', tool_calls: [call('call_a', argumentsText)] }, { role: 'tool', tool_call_id: 'call_a', content: 'result' },
    ] };
    expect(make().convert(input, context)).toMatchObject({ ok: false, error: { code: 'invalid_tool_arguments' } });
  });

  it.each(['../call', 'call\n', 'x'.repeat(129)])('rejects unrepresentable tool ID %# without guessing replacements', id => {
    const input: ChatRequest = { model: 'm', messages: [
      { role: 'assistant', tool_calls: [call(id)] }, { role: 'tool', tool_call_id: id, content: 'result' },
    ] };
    expect(make().convert(input, context)).toMatchObject({ ok: false, error: { code: 'unrepresentable_tool_call_id' } });
  });

  it.each([
    [{ role: 'tool', tool_call_id: 'orphan', content: 'x' }],
    [{ role: 'assistant', tool_calls: [call('a')] }],
    [{ role: 'assistant', tool_calls: [call('a')] }, { role: 'user', content: 'interrupt' }],
    [{ role: 'assistant', tool_calls: [call('a'), call('b')] }, { role: 'tool', tool_call_id: 'a', content: 'x' }],
    [{ role: 'assistant', tool_calls: [call('a')] }, { role: 'tool', tool_call_id: 'a', content: 'x' }, { role: 'tool', tool_call_id: 'a', content: 'duplicate' }],
    [{ role: 'assistant', tool_calls: [call('a')] }, { role: 'tool', tool_call_id: 'b', content: 'wrong' }],
    [{ role: 'assistant', tool_calls: [call('a')] }, { role: 'tool', tool_call_id: 'a', content: 'x' }, { role: 'assistant', tool_calls: [call('a')] }],
  ].map(messages => [messages]))('rejects orphan/duplicate/unanswered/interleaved history %#', messages => {
    expect(make().convert({ model: 'm', messages: messages as ChatMessage[] }, context)).toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
  });

  it('rejects missing/nonobject schemas, duplicate definitions and unknown selected tools', () => {
    for (const tools of [
      [{ type: 'function', function: { name: 'no_schema' } }],
      [{ type: 'function', function: { name: 'bad', parameters: { type: 'array' } } }],
      [definition(), definition()],
    ]) expect(make().convert({ ...basic(), tools } as ChatRequest, context).ok).toBe(false);
    expect(make().convert({ ...request(), tool_choice: { type: 'function', function: { name: 'missing' } } }, context))
      .toMatchObject({ ok: false, error: { code: 'unknown_selected_tool' } });
  });

  it('preserves valid nested arguments and has no pending-ID state across requests', () => {
    const adapter = make();
    const history: ChatRequest = { model: 'm', messages: [
      { role: 'assistant', tool_calls: [call('a', '{"nested":{"values":[1,true,null,"x"]}}')] },
      { role: 'tool', tool_call_id: 'a', content: 'x' },
    ] };
    expect(value(adapter.convert(history, context)).messages[0]?.content).toEqual([
      { type: 'tool_use', id: 'a', name: 'lookup', input: { nested: { values: [1, true, null, 'x'] } } },
    ]);
    expect(adapter.convert(history, context).ok).toBe(true);
    expect(adapter.convert(basic(), context).ok).toBe(true);
  });
});
