import { describe, expect, it } from 'vitest';
import { parseResponsesInput } from '../../apps/worker/gateway/parse-responses';
const valid = { model: 'public/responses', input: 'hello' };
function input(value: unknown) { return new Request('https://console.example/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); }

describe('Responses entry parsing and history requirements', () => {
  it('preserves ordered native message/call/output history and explicit token cap', async () => {
    const value = { model: valid.model, stream: true, max_output_tokens: 100,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'call-1', name: 'lookup', arguments: '{"n":1}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'result' }],
    };
    const parsed = await parseResponsesInput(input(value), { maxOutputTokens: 100 });
    expect(parsed).toMatchObject({ protocol: 'responses', model: valid.model, stream: true, request: value });
    expect(parsed.features.outputTokenLimit).toBe(100);
  });
  it('retains reference-only requests as unverified binding requirements', async () => {
    const parsed = await parseResponsesInput(input({ model: valid.model, previous_response_id: 'resp-unverified' }));
    expect(parsed.features.requiresHistoryBinding).toBe(true);
    expect(parsed.request.previous_response_id).toBe('resp-unverified');
    expect(parsed.request.input).toBeUndefined();
  });
  it('does not treat item_reference IDs as already verified history', async () => {
    const parsed = await parseResponsesInput(input({ ...valid, input: [{ type: 'item_reference', id: 'item-unverified' }] }));
    expect(parsed.features.requiresHistoryBinding).toBe(true);
    expect(parsed.features.required.map(item => item.feature)).toContain('item_references');
  });
  // Field validation belongs to the native parser; this asserts HTTP error translation.
  it('translates malformed native input to an HTTP 400', async () => {
    await expect(parseResponsesInput(input({ model: valid.model }))).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });
  it('rejects out-of-scope background generation before any execution', async () => {
    await expect(parseResponsesInput(input({ ...valid, background: true }))).rejects.toMatchObject({ protocolError: { kind: 'unsupported_feature', code: 'background_out_of_scope' } });
  });
  it('does not clamp output or bypass the shared byte bound', async () => {
    await expect(parseResponsesInput(input({ ...valid, max_output_tokens: 101 }), { maxOutputTokens: 100 })).rejects.toMatchObject({ protocolError: { code: 'output_limit_exceeded' } });
    await expect(parseResponsesInput(input(valid), { maxBodyBytes: 10 })).rejects.toMatchObject({ status: 413 });
  });
});
