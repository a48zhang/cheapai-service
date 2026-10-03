import { describe, expect, it } from 'vitest';
import { parseMessagesInput } from '../../apps/worker/gateway/parse-messages';
const valid = { model: 'public/messages', max_tokens: 2048, messages: [{ role: 'user', content: 'hello' }] };
function input(value: unknown, headers: Record<string, string> = {}) { return new Request('https://console.example/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) }); }

describe('Messages entry parsing and version boundary', () => {
  it('preserves ordered system blocks, tools and explicit output cap', async () => {
    const value = { ...valid, stream: true, system: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
      messages: [...valid.messages, { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { n: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'result' }] }] };
    const parsed = await parseMessagesInput(input(value), { maxOutputTokens: 2048 });
    expect(parsed).toMatchObject({ protocol: 'messages', model: valid.model, stream: true, version: '2023-06-01', request: value });
    expect(parsed.features.outputTokenLimit).toBe(2048);
  });
  it('validates header syntax while retaining unapproved beta requirements', async () => {
    const parsed = await parseMessagesInput(input(valid, { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'example-beta, another-beta, example-beta' }));
    expect(parsed.betas).toEqual(['example-beta', 'another-beta']);
    await expect(parseMessagesInput(input(valid, { 'anthropic-version': 'future-version' }))).rejects.toMatchObject({ protocolError: { code: 'unsupported_messages_version' } });
    await expect(parseMessagesInput(input(valid, { 'anthropic-beta': 'valid,,invalid' }))).rejects.toMatchObject({ protocolError: { code: 'invalid_messages_beta' } });
  });
  it('preserves known native output_config for subsequent capability checking', async () => {
    const parsed = await parseMessagesInput(input({ ...valid, output_config: { effort: 'high' } }));
    expect(parsed.request.output_config).toEqual({ effort: 'high' });
    expect(parsed.features.required.map(item => item.feature)).toContain('reasoning_effort');
  });
  // Keep native-parser and capability-conflict failures, not the parser's full field matrix.
  it.each([{ ...valid, max_tokens: undefined },
    { ...valid, thinking: { type: 'enabled', budget_tokens: 4096 } },
  ])('rejects malformed blocks or conflicting output/thinking limits %#', async value => {
    await expect(parseMessagesInput(input(value))).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });
  it('rejects oversized input/output instead of truncating', async () => {
    await expect(parseMessagesInput(input(valid), { maxOutputTokens: 100 })).rejects.toMatchObject({ protocolError: { code: 'output_limit_exceeded' } });
    await expect(parseMessagesInput(input(valid), { maxBodyBytes: 10 })).rejects.toMatchObject({ status: 413 });
  });
});
