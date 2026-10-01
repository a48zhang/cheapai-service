import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  validateResponsesRequest,
  type ResponsesRequest,
  type ResponsesResponse,
  type ResponsesStreamEvent,
  type ResponsesServiceTier,
} from '../../../packages/apicompat/types/responses.js';

describe('Responses ingress wire structure', () => {
  it('types standard response echoes separately from request support', () => {
    const response = { id: 'resp_fixture', object: 'response', created_at: 1752100704, completed_at: 1752100705,
      model: 'gpt-6-astra', status: 'completed', background: false, store: true, instructions: null,
      max_output_tokens: null, max_tool_calls: null, parallel_tool_calls: true, reasoning: { effort: null, summary: null },
      service_tier: 'default', temperature: 1, top_p: 1, text: { format: { type: 'text' }, verbosity: 'medium' },
      tool_choice: 'auto', tools: [], top_logprobs: 0, truncation: 'disabled', user: null, metadata: {},
      output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Synthetic reply.', annotations: [], logprobs: [] }] }],
      error: null, incomplete_details: null, previous_response_id: null,
      usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    } as const satisfies ResponsesResponse;
    expectTypeOf<ResponsesResponse['service_tier']>().toEqualTypeOf<ResponsesServiceTier | null | undefined>();
    expectTypeOf<ResponsesResponse['parallel_tool_calls']>().toEqualTypeOf<boolean | undefined>();
    expect(response.service_tier).toBe('default');
    expect(validateResponsesRequest({ model: 'm', input: 'x', completed_at: 123 }).ok).toBe(false);
  });
  it('accepts text and preserves a complete history in order without mutation', () => {
    const request = {
      model: 'public-model', instructions: 'Use the supplied history.', stream: true,
      input: [
        { role: 'developer', content: 'Answer briefly.' },
        { role: 'user', content: [{ type: 'input_text', text: 'Describe this' }, { type: 'input_image', image_url: 'data:image/png;base64,YQ==', detail: 'low' }] },
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"city":"Shanghai"}', status: 'completed' },
        { type: 'function_call_output', call_id: 'call_1', output: '{"value":0}' },
        { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Found it.', annotations: [] }] },
        { role: 'user', content: 'And tomorrow?' },
      ],
    };
    const before = structuredClone(request);
    const result = validateResponsesRequest(request);
    expect(result).toEqual({ ok: true, value: request });
    expect(request).toEqual(before);
    expect(validateResponsesRequest({ model: 'm', input: 'hello' }).ok).toBe(true);
  });

  it('expresses native references without claiming ownership or resolving history', () => {
    expect(validateResponsesRequest({ model: 'm', previous_response_id: 'resp_other_user' }).ok).toBe(true);
    expect(validateResponsesRequest({ model: 'm', input: [{ type: 'item_reference', id: 'item_1' }], previous_response_id: null }).ok).toBe(true);
    expect(validateResponsesRequest({ model: 'm', previous_response_id: '' })).toMatchObject({ ok: false, error: { param: 'previous_response_id' } });
  });

  it('retains function schema, forced choice, zero sampling and multimodal tool results', () => {
    const result = validateResponsesRequest({ model: 'm', input: [
      { type: 'function_call_output', call_id: 'call_1', output: [
        { type: 'input_text', text: 'result' }, { type: 'input_image', file_id: 'file_1' },
        { type: 'input_file', filename: 'report.txt', file_data: 'YQ==' },
      ] },
    ], tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }, strict: true }],
    tool_choice: { type: 'function', name: 'lookup' }, parallel_tool_calls: false,
    temperature: 0, top_p: 0, max_output_tokens: 1, metadata: null, reasoning: { effort: 'low' }, text: { format: { type: 'json_object' } } });
    expect(result.ok).toBe(true);
  });

  it.each([
    [null, '$'], [[], '$'], [{ input: 'x' }, 'model'], [{ model: ' ' , input: 'x' }, 'model'],
    [{ model: 'm' }, 'input'], [{ model: 'm', input: null }, 'input'],
    [{ model: 'm', input: [{ role: 'tool', content: 'x' }] }, 'input[0].role'],
    [{ model: 'm', input: [{ role: ['user'], content: 'x' }] }, 'input[0].role'],
    [{ model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: 1 }] }] }, 'input[0].content[0].text'],
    [{ model: 'm', input: [{ role: 'user', content: [{ type: 'input_image' }] }] }, 'input[0].content[0]'],
    [{ model: 'm', input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_1', detail: ['low'] }] }] }, 'input[0].content[0].detail'],
    [{ model: 'm', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'a', file_id: 'b' }] }] }, 'input[0].content[0]'],
    [{ model: 'm', input: [{ role: 'user', content: [{ type: 'output_text', text: 'x', annotations: [] }] }] }, 'input[0].content[0]'],
    [{ model: 'm', input: [{ type: 'function_call', name: 'f', arguments: '{}' }] }, 'input[0].call_id'],
    [{ model: 'm', input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: {} }] }, 'input[0].arguments'],
    [{ model: 'm', input: [{ type: 'function_call_output', call_id: 'c', output: {} }] }, 'input[0].output'],
    [{ model: 'm', input: [{ type: 'message', role: 'assistant', content: 'x', status: 'failed' }] }, 'input[0].status'],
    [{ model: 'm', input: 'x', stream: 'true' }, 'stream'],
    [{ model: 'm', input: 'x', max_output_tokens: 0 }, 'max_output_tokens'],
    [{ model: 'm', input: 'x', max_output_tokens: 1.5 }, 'max_output_tokens'],
    [{ model: 'm', input: 'x', temperature: 3 }, 'temperature'],
    [{ model: 'm', input: 'x', top_p: -1 }, 'top_p'],
    [{ model: 'm', input: 'x', tools: [{ type: 'function', name: 'f', strict: 1 }] }, 'tools[0].strict'],
    [{ model: 'm', input: 'x', tool_choice: { type: 'function', name: '' } }, 'tool_choice'],
    [{ model: 'm', input: 'x', text: [] }, 'text'],
  ])('rejects malformed structure %# at a useful path', (request, param) => {
    expect(validateResponsesRequest(request)).toMatchObject({ ok: false, error: { kind: 'invalid_request', param } });
  });

  it('rejects unknown fields by default and preserves JSON extensions only explicitly', () => {
    const request = { model: 'm', input: [{ role: 'user', content: 'x', vendor_hint: { flag: true } }], provider_setting: 7 };
    expect(validateResponsesRequest(request)).toMatchObject({ ok: false, error: { kind: 'unsupported_feature', param: 'input[0].vendor_hint' } });
    expect(validateResponsesRequest(request, { unknownFields: 'preserve' })).toEqual({ ok: true, value: request });
    // Preserving extras cannot bypass checks on a known field.
    expect(validateResponsesRequest({ ...request, stream: 1 }, { unknownFields: 'preserve' }).ok).toBe(false);
  });

  it.each([
    { model: 'm', input: [{ type: 'computer_call', id: 'x' }] },
    { model: 'm', input: 'x', tools: [{ type: 'web_search' }] },
  ])('explicitly rejects unimplemented discriminants even in preserve mode', request => {
    expect(validateResponsesRequest(request, { unknownFields: 'preserve' })).toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
  });

  it('rejects non-JSON preserved data, cycles and excessive nesting without throwing', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let deep: unknown = 'leaf'; for (let i = 0; i < 70; i++) deep = { child: deep };
    for (const extension of [undefined, Infinity, NaN, 1n, () => 1, new Date(), cycle, deep, [ , 'hole']]) {
      expect(validateResponsesRequest({ model: 'm', input: 'x', extension }, { unknownFields: 'preserve' })).toMatchObject({ ok: false, error: { param: '$' } });
    }
  });

  it('models incomplete/error outcomes and fragmented SSE independently from request validation', () => {
    const response = { id: 'resp_1', object: 'response', created_at: 0, model: 'm', status: 'incomplete', output: [],
      incomplete_details: { reason: 'max_output_tokens' }, error: null,
      usage: { input_tokens: 0, output_tokens: 2, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1 } },
    } as const satisfies ResponsesResponse;
    const delta = { type: 'response.function_call_arguments.delta', sequence_number: 0, item_id: 'fc_1', output_index: 0, delta: '{"city":' } as const satisfies ResponsesStreamEvent;
    expectTypeOf(response).toExtend<ResponsesResponse>();
    expectTypeOf(delta).toExtend<ResponsesStreamEvent>();
    expectTypeOf<ReturnType<typeof validateResponsesRequest>>().extract<{ ok: true }>().toHaveProperty('value').toEqualTypeOf<ResponsesRequest>();
    expect(delta.delta).toBe('{"city":');
  });
});
