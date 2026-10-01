import { describe, expect, it } from 'vitest';
import { parseChatInput } from '../../apps/worker/gateway/parse-chat';

const valid = { model: 'public/model', messages: [{ role: 'user', content: 'hello' }] };
function input(value: unknown) { return new Request('https://console.example/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); }

describe('Chat gateway input -> wire parser -> capability requirements', () => {
  it('preserves complete text/tool history and extracts stream/output requirements', async () => {
    const payload = { ...valid, stream: true, stream_options: { include_usage: true }, max_completion_tokens: 128,
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
      messages: [...valid.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'result' }] };
    const parsed = await parseChatInput(input(payload), { maxOutputTokens: 128 });
    expect(parsed).toMatchObject({ protocol: 'chat', request: payload, model: valid.model, stream: true });
    expect(parsed.features.outputTokenLimit).toBe(128);
    expect(parsed.features.required.map(r => r.feature)).toEqual(expect.arrayContaining(['streaming', 'stream_usage', 'tools']));
  });
  it('keeps absent output limit absent and unknown extensions awaiting later approval', async () => {
    const parsed = await parseChatInput(input({ ...valid, vendor_setting: { mode: 'native' } }));
    expect(parsed.stream).toBe(false); expect(parsed.features.outputTokenLimit).toBeUndefined();
    expect(parsed.request.vendor_setting).toEqual({ mode: 'native' });
    expect(parsed.features.extensions).toContainEqual({ scope: 'request', name: 'vendor_setting', path: '$.vendor_setting' });
  });
  it.each([
    { ...valid, model: 'trailing\n' }, { ...valid, messages: [] }, { ...valid, stream: 'true' },
    { ...valid, max_completion_tokens: -1 }, { ...valid, max_tokens: 10, max_completion_tokens: 11 },
  ])('rejects invalid wire/feature constraints %#', async payload => {
    await expect(parseChatInput(input(payload))).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });
  it('rejects above configured output cap instead of silently clamping', async () => {
    await expect(parseChatInput(input({ ...valid, max_completion_tokens: 129 }), { maxOutputTokens: 128 })).rejects.toMatchObject({ protocolError: { code: 'output_limit_exceeded' } });
    await expect(parseChatInput(input(valid), { maxOutputTokens: 0 })).rejects.toMatchObject({ code: 'service_unavailable' });
  });
  it('honors the bounded HTTP reader before parsing a large prompt', async () => {
    await expect(parseChatInput(input(valid), { maxBodyBytes: 10 })).rejects.toMatchObject({ status: 413 });
  });
});
