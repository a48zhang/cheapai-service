import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createResponsesToMessagesRequestAdapter } from '../../../packages/apicompat/requests/responses-to-messages.js';
import type { RequestAdapter } from '../../../packages/apicompat/types/adapter.js';
import type { ResponsesRequest } from '../../../packages/apicompat/types/responses.js';
import { parseMessagesRequest } from '../../../packages/apicompat/types/messages.js';
import type { MessagesRequest } from '../../../packages/apicompat/types/messages.js';
import type { ConversionResult } from '../../../packages/apicompat/types/shared.js';

// Original synthetic histories, not upstream fixtures or provider recordings.
function value<T>(result: ConversionResult<T>): T { if (!result.ok) throw new Error(result.error.code); return result.value; }
const adapter = () => value(createResponsesToMessagesRequestAdapter({ maxTokens: 256 }));
const context = { targetModel: 'messages-upstream' };
const basic = (): ResponsesRequest => ({ model: 'public', input: 'Hello' });

describe('P-RM-Q1 text and roles', () => {
  it('implements the direct adapter with explicit target model and policy budget', () => {
    const convert = adapter();
    expectTypeOf(convert).toEqualTypeOf<RequestAdapter<ResponsesRequest, MessagesRequest, 'responses', 'messages'>>();
    expect(convert).toMatchObject({ from: 'responses', to: 'messages' });
    const output = value(convert.convert(basic(), context));
    expect(output).toEqual({ model: context.targetModel, max_tokens: 256, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] });
    expect(parseMessagesRequest(output).ok).toBe(true);
  });
  it('maps instructions before ordered system-prefix blocks and conversation', () => {
    const output = value(adapter().convert({ ...basic(), instructions: 'First\n', input: [
      { role: 'system', content: [{ type: 'input_text', text: 'Second' }, { type: 'input_text', text: ' Third' }] },
      { role: 'user', content: 'question' },
    ] }, context));
    expect(output.system).toEqual([{ type: 'text', text: 'First\n' }, { type: 'text', text: 'Second' }, { type: 'text', text: ' Third' }]);
  });
  it.each(['system', 'developer'] as const)('supports a homogeneous %s prefix without dropping or labeling text', role => {
    const output = value(adapter().convert({ model: 'm', input: [
      { role, content: 'one' }, { role, content: [{ type: 'input_text', text: 'two' }] }, { role: 'user', content: 'question' },
    ] }, context));
    expect(output.system).toEqual([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]);
    expect(output.messages).toHaveLength(1);
  });
  it('preserves full multi-turn history while merging only adjacent equal roles', () => {
    const output = value(adapter().convert({ model: 'm', input: [
      { role: 'user', content: 'u0' }, { role: 'user', content: [{ type: 'input_text', text: 'u1' }, { type: 'input_text', text: '' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'a0', annotations: [] }] },
      { role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' },
    ] }, context));
    expect(output.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'u0' }, { type: 'text', text: 'u1' }, { type: 'text', text: '' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a0' }, { type: 'text', text: 'a1' }] },
      { role: 'user', content: [{ type: 'text', text: 'u2' }] },
    ]);
    expect(parseMessagesRequest(output).ok).toBe(true);
  });
  it('preserves empty/Unicode text and distinguishes null from present empty instructions', () => {
    expect(value(adapter().convert({ model: 'm', instructions: '', input: ' 空白🧪\n' }, context)).system).toEqual([{ type: 'text', text: '' }]);
    expect(value(adapter().convert({ model: 'm', instructions: null, input: '' }, context))).not.toHaveProperty('system');
  });
  it.each([
    { model: 'm', instructions: 'system', input: [{ role: 'developer', content: 'different priority' }, { role: 'user', content: 'x' }] },
    { model: 'm', input: [{ role: 'developer', content: 'one' }, { role: 'system', content: 'two' }, { role: 'user', content: 'x' }] },
    { model: 'm', input: [{ role: 'user', content: 'earlier' }, { role: 'developer', content: 'later' }] },
    { model: 'm', input: [{ role: 'assistant', content: 'earlier' }, { role: 'system', content: 'later' }] },
  ])('rejects priority collapse or instruction hoisting %#', request => {
    expect(adapter().convert(request as ResponsesRequest, context)).toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
  });
  it.each([
    { tool_choice: 'none' }, { parallel_tool_calls: false }, { store: false }, { background: false },
    { previous_response_id: null }, { previous_response_id: 'stateful' }, { metadata: {} }, { vendor: true },
  ])('rejects later-node controls/extensions %#', extra => {
    expect(adapter().convert({ ...basic(), ...extra } as ResponsesRequest, context)).toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
  });
  it.each([
    { type: 'function_call', call_id: 'a', name: 'f', arguments: '{}' },
    { type: 'function_call_output', call_id: 'a', output: 'x' }, { type: 'item_reference', id: 'item' },
    { type: 'reasoning', id: 'r', summary: [] },
    { role: 'user', content: [{ type: 'input_image', image_url: 'https://image.example/x' }] },
    { role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'x', annotations: [{ type: 'citation' }] }] },
  ])('rejects unimplemented item/content semantics %#', item => {
    expect(adapter().convert({ model: 'm', input: [item] } as ResponsesRequest, context).ok).toBe(false);
  });
  it('requires conversational content and valid source structure', () => {
    expect(adapter().convert({ model: 'm', instructions: 'only', input: [] }, context)).toMatchObject({ ok: false, error: { code: 'messages_conversation_required' } });
    expect(adapter().convert({ model: 'm', input: [{ role: 'user', content: {} }] } as unknown as ResponsesRequest, context)).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
  });
  it.each([0, -1, NaN, 0.5, Infinity])('never guesses an output budget when invalid: %s', maxTokens => {
    expect(createResponsesToMessagesRequestAdapter({ maxTokens }).ok).toBe(false);
  });
  it('snapshots budget, validates target model and avoids source aliases or cross-request state', () => {
    const options = { maxTokens: 7 }; const instance = value(createResponsesToMessagesRequestAdapter(options)); options.maxTokens = 100;
    const content = Object.freeze([{ type: 'input_text' as const, text: 'frozen' }]);
    const source = Object.freeze({ model: 'm', instructions: 'one request', input: Object.freeze([{ role: 'user' as const, content }]) });
    const first = value(instance.convert(source, context));
    expect(first.max_tokens).toBe(7); expect(first.messages[0]?.content).not.toBe(content);
    expect(value(instance.convert(basic(), context))).not.toHaveProperty('system');
    expect(instance.convert(basic(), { targetModel: '' })).toMatchObject({ ok: false, error: { code: 'invalid_target_model' } });
  });
});

describe('P-RM-Q6 known cache scope and completed items',()=>{
  const configured=()=>value(createResponsesToMessagesRequestAdapter({maxTokens:256,channelCapabilities:{protocol:'messages',features:['cache_control','tools','strict_tools','image_url'],cacheTtls:['5m','1h']}}));
  it('preserves request/tool/system block cache markers at native boundaries',()=>{
    const input:ResponsesRequest={model:'m',cache_control:{type:'ephemeral'},tools:[{type:'function',name:'f',strict:false,parameters:{type:'object'},cache_control:{type:'ephemeral',ttl:'1h'}}],input:[
      {role:'system',content:[{type:'input_text',text:'system',cache_control:{type:'ephemeral',ttl:'1h'}}]},
      {role:'user',content:[{type:'input_text',text:'user',cache_control:{type:'ephemeral'}}]},
    ]};
    const output=value(configured().convert(input,context));
    expect(output.cache_control).toEqual({type:'ephemeral'});
    expect(output.tools?.[0]?.cache_control).toEqual({type:'ephemeral',ttl:'1h'});
    expect(output.system).toMatchObject([{cache_control:{type:'ephemeral',ttl:'1h'}}]);
    expect(output.messages[0]?.content).toMatchObject([{cache_control:{type:'ephemeral'}}]);
    expect(parseMessagesRequest(output).ok).toBe(true);
  });
  it('retains image cache markers and requires explicit TTL capability',()=>{
    const input:ResponsesRequest={model:'m',input:[{role:'user',content:[{type:'input_image',image_url:'https://image.example/x',cache_control:{type:'ephemeral',ttl:'1h'}}]}]};
    expect(configured().convert(input,context)).toMatchObject({ok:true,value:{messages:[{content:[{type:'image',cache_control:{type:'ephemeral',ttl:'1h'}}]}]}});
    expect(adapter().convert(input,context).ok).toBe(false);
  });
  it('uses call_id rather than native item IDs while accepting completed full-content items',()=>{
    const output=value(configured().convert({model:'m',input:[
      {type:'function_call',id:'source_call',status:'completed',call_id:'actual',name:'f',arguments:'{}'},
      {type:'function_call_output',id:'source_output',status:'completed',call_id:'actual',output:'result'},
    ]},context));
    expect(output.messages).toMatchObject([{content:[{id:'actual'}]},{content:[{tool_use_id:'actual'}]}]);
    expect(JSON.stringify(output)).not.toContain('source_');
  });
  it.each([{type:'permanent'},{type:'ephemeral',ttl:'24h'},{type:'ephemeral',secret:'PRIVATE'}])('rejects malformed cache control %#',cache_control=>{
    const result=configured().convert({...basic(),cache_control},context);expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('rejects invalid TTL order, unresolved references and unapproved scopes',()=>{
    expect(configured().convert({model:'m',input:[{role:'system',content:[{type:'input_text',text:'s',cache_control:{type:'ephemeral'}}]},{role:'user',content:[{type:'input_text',text:'u',cache_control:{type:'ephemeral',ttl:'1h'}}]}]},context)).toMatchObject({ok:false,error:{code:'invalid_cache_ttl_order'}});
    expect(configured().convert({model:'m',input:[{role:'user',content:'x',cache_control:{type:'ephemeral'}}]},context).ok).toBe(false);
    expect(configured().convert({model:'m',input:[{type:'item_reference',id:'source'}]},context).ok).toBe(false);
    expect(configured().convert({model:'m',input:[{role:'assistant',content:'partial',status:'incomplete'}]},context).ok).toBe(false);
  });
});

describe('P-RM-Q5 native qualitative effort',()=>{
  const configured=()=>value(createResponsesToMessagesRequestAdapter({maxTokens:256,channelCapabilities:{protocol:'messages',features:['reasoning_effort'],reasoningEfforts:['low','medium','high']}}));
  it.each(['low','medium','high'])('maps effort %s without synthesizing thinking budgets',effort=>{
    const output=value(configured().convert({...basic(),reasoning:{effort}},context));
    expect(output.output_config).toEqual({effort});expect(output.max_tokens).toBe(256);expect(output).not.toHaveProperty('thinking');
    expect(parseMessagesRequest(output).ok).toBe(true);
  });
  it('does not guess unsupported levels or skip required capabilities',()=>{
    for(const effort of ['none','minimal','xhigh','max'])expect(configured().convert({...basic(),reasoning:{effort}},context).ok).toBe(false);
    expect(adapter().convert({...basic(),reasoning:{effort:'high'}},context).ok).toBe(false);
    expect(value(adapter().convert({...basic(),reasoning:{effort:null}},context))).not.toHaveProperty('output_config');
  });
  it('rejects summary/private history without turning it into ordinary content',()=>{
    const result=configured().convert({model:'m',input:[{type:'reasoning',id:'r',summary:[{type:'summary_text',text:'PRIVATE'}],encrypted_content:'PRIVATE'}]},context);
    expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(configured().convert({...basic(),reasoning:{effort:'high',summary:'auto'}},context).ok).toBe(false);
  });
});

describe('P-RM-Q4-O strict output schema', () => {
  const configured=()=>value(createResponsesToMessagesRequestAdapter({maxTokens:128,channelCapabilities:{protocol:'messages',features:['json_schema']}}));
  const schema=()=>({type:'object',properties:{x:{type:'string'}},required:['x'],additionalProperties:false});
  it('maps strict format constraints and description to output_config',()=>{
    const output=value(configured().convert({...basic(),text:{format:{type:'json_schema',name:'out',schema:schema(),strict:true,description:'Output'}}},context));
    expect(output.output_config).toEqual({format:{type:'json_schema',schema:{...schema(),description:'Output'}}});
    expect(parseMessagesRequest(output).ok).toBe(true);
  });
  it('does not impose a structured format on explicit text',()=>{
    expect(value(adapter().convert({...basic(),text:{format:{type:'text'}}},context))).not.toHaveProperty('output_config');
  });
  it.each([false,null,undefined])('refuses advisory/default strict=%s',strict=>{
    expect(configured().convert({...basic(),text:{format:{type:'json_schema',name:'out',schema:schema(),...(strict===undefined?{}:{strict})}}},context).ok).toBe(false);
  });
  it('rejects JSON-only mode, complex schema/description conflicts and missing capability',()=>{
    expect(configured().convert({...basic(),text:{format:{type:'json_object'}}},context).ok).toBe(false);
    expect(configured().convert({...basic(),text:{format:{type:'json_schema',name:'out',strict:true,schema:{...schema(),description:'different'},description:'Output'}}},context).ok).toBe(false);
    expect(adapter().convert({...basic(),text:{format:{type:'json_schema',name:'out',strict:true,schema:schema()}}},context).ok).toBe(false);
  });
});

describe('P-RM-Q4 generation controls', () => {
  const configured = () => value(createResponsesToMessagesRequestAdapter({ maxTokens: 128, channelCapabilities: {
    protocol: 'messages', features: ['temperature','top_p','streaming'], maxOutputTokens: 256,
  } }));
  it('maps explicit limit/sampling/stream without clamping', () => {
    expect(configured().convert({ ...basic(), max_output_tokens: 200, temperature: 0, top_p: 1, stream: true },context))
      .toMatchObject({ok:true,value:{max_tokens:200,temperature:0,top_p:1,stream:true}});
    expect(configured().convert({ ...basic(), max_output_tokens: 257 },context).ok).toBe(false);
  });
  it('uses explicit fallback for null limit and does not invent sampler defaults', () => {
    const output=value(configured().convert({ ...basic(), max_output_tokens:null,temperature:null,top_p:null,stream:false },context));
    expect(output.max_tokens).toBe(128);expect(output.stream).toBe(false);expect(output).not.toHaveProperty('temperature');
  });
  it('rejects incompatible sampling, missing capability and nonnative stop controls', () => {
    expect(configured().convert({ ...basic(), temperature:1.5 },context).ok).toBe(false);
    expect(adapter().convert({ ...basic(), top_p:0.5 },context).ok).toBe(false);
    expect(configured().convert({ ...basic(), stop:['END'] },context).ok).toBe(false);
  });
});

describe('P-RM-Q3 image sources', () => {
  const configured = () => value(createResponsesToMessagesRequestAdapter({ maxTokens: 256, channelCapabilities: { protocol: 'messages', features: ['image_url','image_base64','tools','tool_result_images'] } }));
  const input = (image_url: string, detail?: 'auto'|'low'|'high'|'original'): ResponsesRequest => ({ model: 'm', input: [{ role: 'user', content: [
    { type: 'input_text', text: 'before' }, { type: 'input_image', image_url, ...(detail ? { detail } : {}) }, { type: 'input_text', text: 'after' },
  ] }] });
  it('maps automatic URL images without network IO', () => {
    const spy = vi.spyOn(globalThis,'fetch').mockImplementation(() => { throw new Error('no fetch'); });
    try {
      const output = value(configured().convert(input('https://image.example/x','auto'),context));
      expect(output.messages[0]).toMatchObject({ content: [{ text: 'before' }, { type:'image',source:{type:'url',url:'https://image.example/x'} }, { text:'after' }] });
      expect(parseMessagesRequest(output).ok).toBe(true); expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it.each(['png','jpeg','gif','webp'])('preserves MIME %s in base64 source', subtype => {
    expect(configured().convert(input(`data:image/${subtype};base64,AQID`),context)).toMatchObject({ ok:true,value:{messages:[{content:[{text:'before'},{source:{type:'base64',media_type:`image/${subtype}`,data:'AQID'}},{text:'after'}]}]} });
  });
  it('preserves tool-result image order with declared capabilities', () => {
    const result = configured().convert({ model:'m',input:[{type:'function_call',call_id:'a',name:'f',arguments:'{}'},
      {type:'function_call_output',call_id:'a',output:[{type:'input_text',text:'result'},{type:'input_image',image_url:'https://image.example/x'}]}] },context);
    expect(result).toMatchObject({ok:true,value:{messages:[{role:'assistant'},{role:'user',content:[{type:'tool_result',content:[{text:'result'},{type:'image'}]}]}]}});
  });
  it('rejects missing image policy, fixed detail and unresolved file IDs', () => {
    expect(adapter().convert(input('https://image.example/x'),context).ok).toBe(false);
    for(const detail of ['low','high','original'] as const) expect(configured().convert(input('https://image.example/x',detail),context).ok).toBe(false);
    expect(configured().convert({model:'m',input:[{role:'user',content:[{type:'input_image',file_id:'file'}]}]},context).ok).toBe(false);
  });
  it.each(['data:image/svg+xml;base64,AQID','data:image/png;base64,AR==','http://image.example/x','https://u:p@image.example/x'])('rejects invalid source %#', url => {
    expect(configured().convert(input(url),context).ok).toBe(false);
  });
});

describe('P-RM-Q2 complete function history', () => {
  const configured = () => value(createResponsesToMessagesRequestAdapter({ maxTokens: 256, channelCapabilities: { protocol: 'messages',
    features: ['tools', 'strict_tools', 'tool_choice', 'parallel_tools', 'parallel_tool_control'], maxOutputTokens: 512 } }));
  const tool = () => ({ type: 'function' as const, name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } });
  const source = (): ResponsesRequest => ({ model: 'm', tools: [tool()], input: [
    { role: 'assistant', content: 'before' }, { type: 'function_call', call_id: 'a', name: 'lookup', arguments: '{"q":"a"}' },
    { role: 'assistant', content: 'between' }, { type: 'function_call', call_id: 'b', name: 'lookup', arguments: '{"q":"b"}' },
    { type: 'function_call_output', call_id: 'b', output: 'B' }, { type: 'function_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'A' }] },
  ] });
  it('normalizes ordinary default strict schema and preserves direct tool/text/result ordering', () => {
    const output = value(configured().convert(source(), context));
    expect(output.tools).toMatchObject([{ name: 'lookup', strict: true, input_schema: { type: 'object', required: ['q'], additionalProperties: false } }]);
    expect(output.messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'before' }, { type: 'tool_use', id: 'a', name: 'lookup', input: { q: 'a' } }, { type: 'text', text: 'between' }, { type: 'tool_use', id: 'b', name: 'lookup', input: { q: 'b' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'B' }, { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'A' }] }] },
    ]);
    expect(parseMessagesRequest(output).ok).toBe(true);
  });
  it.each(['auto', 'none', 'required'] as const)('maps choice %s', tool_choice => {
    expect(configured().convert({ ...source(), tool_choice }, context)).toMatchObject({ ok: true, value: { tool_choice: { type: tool_choice === 'required' ? 'any' : tool_choice } } });
  });
  it('maps named choice/parallel control and explicit false schema without normalization', () => {
    const parameters = { ...tool().parameters, additionalProperties: true };
    expect(configured().convert({ ...source(), tools: [{ ...tool(), parameters, strict: false }], tool_choice: { type: 'function', name: 'lookup' }, parallel_tool_calls: false }, context))
      .toMatchObject({ ok: true, value: { tools: [{ strict: false, input_schema: parameters }], tool_choice: { type: 'tool', name: 'lookup', disable_parallel_tool_use: true } } });
  });
  it('requires actual target strict capability after default normalization', () => {
    const noStrict = value(createResponsesToMessagesRequestAdapter({ maxTokens: 256, channelCapabilities: { protocol: 'messages', features: ['tools', 'parallel_tools'] } }));
    expect(noStrict.convert(source(), context).ok).toBe(false);
    expect(adapter().convert(source(), context).ok).toBe(false);
  });
  it.each(['orphan', 'duplicate', 'missing', 'interrupt'])('rejects incorrect associations %s', kind => {
    const input = kind === 'orphan' ? [{ type: 'function_call_output', call_id: 'x', output: 'x' }]
      : [{ type: 'function_call', call_id: 'a', name: 'lookup', arguments: '{}' }, ...(kind === 'missing' ? [] : kind === 'interrupt'
        ? [{ role: 'user', content: 'interrupt' }] : [{ type: 'function_call_output', call_id: 'a', output: 'x' }, { type: 'function_call_output', call_id: 'a', output: 'duplicate' }])];
    expect(configured().convert({ model: 'm', input } as ResponsesRequest, context).ok).toBe(false);
  });
  it.each(['[]', '', '{', '{"n":9007199254740993}', '{"n":1e999}'])('rejects invalid/object-incompatible arguments %#', argumentsText => {
    expect(configured().convert({ model: 'm', input: [{ type: 'function_call', call_id: 'a', name: 'lookup', arguments: argumentsText }, { type: 'function_call_output', call_id: 'a', output: '' }] }, context).ok).toBe(false);
  });
  it('rejects built-in tools and ambiguous schema fallback without relabeling them as functions', () => {
    expect(configured().convert({ ...basic(), tools: [{ type: 'web_search' }] } as unknown as ResponsesRequest, context).ok).toBe(false);
    expect(configured().convert({ ...basic(), tools: [{ ...tool(), parameters: { type: 'object', $ref: '#/unknown' } }] }, context).ok).toBe(false);
  });
});
