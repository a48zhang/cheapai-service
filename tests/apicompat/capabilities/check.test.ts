import { describe, expect, it } from 'vitest';
import { checkRequestCapabilities, identifyRequestFeatures } from '../../../packages/apicompat/capabilities/check';
import type { ProtocolRequest, ChannelCapabilities } from '../../../packages/apicompat/capabilities/check';

const chat = (patch = {}): ProtocolRequest => ({ protocol: 'chat', request: { model: 'm', messages: [{ role: 'user', content: 'hello' }], max_completion_tokens: 64, ...patch } });
const target = (protocol: ChannelCapabilities['protocol']): ChannelCapabilities => ({ protocol, features: [] });

describe('protocol representability rather than declared capability policy', () => {
  it('reuses parsed features and accepts native extensions without declarations', () => {
    const request = chat({ stream: true, reasoning_effort: 'xhigh', vendor: { token: 'data', nested: true }, tools: [{ type: 'function', function: { name: 'lookup', strict: true } }] });
    const identified = identifyRequestFeatures(request);
    expect(identified.ok).toBe(true);
    if (!identified.ok) return;
    const result = checkRequestCapabilities(request, target('chat'), identified.value);
    expect(result).toMatchObject({ supported: true, outputTokenLimit: 64 });
    if (result.supported) expect(result.features).toBe(identified.value);
  });
  it('permits portable tools without optional feature metadata', () => {
    for (const protocol of ['chat', 'messages', 'responses'] as const) {
      expect(checkRequestCapabilities(chat({ tools: [{ type: 'function', function: { name: 'lookup' } }] }), target(protocol)).supported).toBe(true);
    }
  });
  it('rejects unknown extensions only when translating them would lose data', () => {
    expect(checkRequestCapabilities(chat({ provider_option: true }), target('chat')).supported).toBe(true);
    expect(checkRequestCapabilities(chat({ provider_option: true }), target('responses'))).toMatchObject({ supported: false, reasons: [{ code: 'no_protocol_mapping', path: '$.provider_option' }] });
  });
  it('retains channel output limits and the Messages output-token requirement', () => {
    expect(checkRequestCapabilities(chat(), { ...target('chat'), maxOutputTokens: 32 })).toMatchObject({ supported: false, reasons: [{ code: 'output_limit_exceeded' }] });
    expect(checkRequestCapabilities(chat({ max_completion_tokens: undefined }), target('messages'))).toMatchObject({ supported: false, reasons: [{ code: 'output_limit_required' }] });
  });
  it('does not weaken a constraint that cannot be represented across protocols', () => {
    expect(checkRequestCapabilities(chat({ temperature: 1.5 }), target('messages')).supported).toBe(false);
    expect(checkRequestCapabilities(chat({ reasoning_effort: 'xhigh' }), target('messages')).supported).toBe(false);
    expect(checkRequestCapabilities(chat({ n: 2 }), target('responses')).supported).toBe(false);
  });
  it('keeps native encrypted history intact but requires reference ownership', () => {
    const request: ProtocolRequest = { protocol: 'responses', request: { model: 'm', previous_response_id: 'native', input: [{ type: 'reasoning', id: 'r', summary: [], encrypted_content: 'opaque' }] } };
    expect(checkRequestCapabilities(request, target('responses'))).toMatchObject({ supported: true, requiredChecks: ['response_history_binding'] });
    expect(checkRequestCapabilities(request, target('chat')).supported).toBe(false);
  });
  it('retains file-reference ownership checks independent of model declarations', () => {
    const request: ProtocolRequest = { protocol: 'responses', request: { model: 'm', input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file-native' }] }] } };
    expect(checkRequestCapabilities(request, target('responses'))).toMatchObject({ supported: true, requiredChecks: ['file_reference_binding'] });
  });
  it('does not admit background jobs without an asynchronous accounting lifecycle', () => {
    expect(checkRequestCapabilities({ protocol: 'responses', request: { model: 'm', input: 'hello', background: true } }, target('responses')).supported).toBe(false);
  });
});
