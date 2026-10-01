import { describe, expect, it } from 'vitest';
import { mapFinishToTarget, normalizeFinish } from '../../packages/apicompat/finish-reasons.js';
import type { NativeFinishInput } from '../../packages/apicompat/finish-reasons.js';
import type { ConversionResult, Protocol, ProtocolError } from '../../packages/apicompat/types/shared.js';

// Original synthetic matrix; no provider recordings or upstream fixtures copied.
function value<T>(result: ConversionResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
const protocols: readonly Protocol[] = ['chat', 'responses', 'messages'];
const sourceMatrix: readonly [NativeFinishInput, string, string][] = [
  [{ from: 'chat', rawReason: 'stop' }, 'completed', 'stop'],
  [{ from: 'chat', rawReason: 'tool_calls' }, 'completed', 'tool_calls'],
  [{ from: 'chat', rawReason: 'function_call' }, 'completed', 'tool_calls'],
  [{ from: 'chat', rawReason: 'length' }, 'incomplete', 'length'],
  [{ from: 'chat', rawReason: 'content_filter' }, 'incomplete', 'content_filter'],
  [{ from: 'chat', rawReason: 'stop', hasRefusal: true }, 'incomplete', 'refusal'],
  [{ from: 'chat', rawReason: 'future_reason' }, 'incomplete', 'unknown'],
  [{ from: 'messages', rawReason: 'end_turn' }, 'completed', 'stop'],
  [{ from: 'messages', rawReason: 'stop_sequence' }, 'completed', 'stop'],
  [{ from: 'messages', rawReason: 'tool_use' }, 'completed', 'tool_calls'],
  [{ from: 'messages', rawReason: 'max_tokens' }, 'incomplete', 'length'],
  [{ from: 'messages', rawReason: 'model_context_window_exceeded' }, 'incomplete', 'length'],
  [{ from: 'messages', rawReason: 'refusal' }, 'incomplete', 'refusal'],
  [{ from: 'messages', rawReason: 'pause_turn' }, 'incomplete', 'unknown'],
  [{ from: 'messages', rawReason: 'future_reason' }, 'incomplete', 'unknown'],
  [{ from: 'responses', rawReason: 'completed' }, 'completed', 'stop'],
  [{ from: 'responses', rawReason: 'completed', hasToolCalls: true }, 'completed', 'tool_calls'],
  [{ from: 'responses', rawReason: 'completed', hasRefusal: true }, 'incomplete', 'refusal'],
  [{ from: 'responses', rawReason: 'incomplete', incompleteReason: 'max_output_tokens' }, 'incomplete', 'length'],
  [{ from: 'responses', rawReason: 'incomplete', incompleteReason: 'content_filter' }, 'incomplete', 'content_filter'],
  [{ from: 'responses', rawReason: 'incomplete', incompleteReason: 'refusal' }, 'incomplete', 'refusal'],
  [{ from: 'responses', rawReason: 'incomplete', incompleteReason: 'future_reason' }, 'incomplete', 'unknown'],
  [{ from: 'responses', rawReason: 'incomplete' }, 'incomplete', 'unknown'],
  [{ from: 'responses', rawReason: 'future_status' }, 'incomplete', 'unknown'],
];

describe('native finish normalization', () => {
  it.each(sourceMatrix)('normalizes %j as %s/%s', (input, status, reason) => {
    const result = value(normalizeFinish(input));
    expect(result).toMatchObject({ from: input.from, rawReason: input.rawReason, terminal: { status, reason }, finishReason: reason });
  });
  it.each(protocols)('separates failure, cancellation, and unexpected EOF for %s', from => {
    const error: ProtocolError = { kind: 'upstream_error', code: 'upstream_failed', message: 'Safe error.' };
    expect(value(normalizeFinish({ from, rawReason: null, event: 'failed', error }))).toMatchObject({ terminal: { status: 'failed', error }, finishReason: null });
    expect(value(normalizeFinish({ from, rawReason: null, event: 'cancelled' }))).toMatchObject({ terminal: { status: 'cancelled' }, finishReason: null });
    expect(value(normalizeFinish({ from, rawReason: null, event: 'eof' }))).toMatchObject({ terminal: { status: 'incomplete', reason: 'unexpected_eof' }, finishReason: null });
    expect(normalizeFinish({ from, rawReason: null }).ok).toBe(false);
  });
  it('recognizes Responses failed/cancelled but not in_progress or queued as terminal', () => {
    expect(value(normalizeFinish({ from: 'responses', rawReason: 'failed' })).terminal.status).toBe('failed');
    expect(value(normalizeFinish({ from: 'responses', rawReason: 'cancelled' })).terminal.status).toBe('cancelled');
    for (const rawReason of ['queued', 'in_progress']) expect(normalizeFinish({ from: 'responses', rawReason })).toMatchObject({ ok: false, error: { code: 'nonterminal_response_status' } });
  });
  it('does not infer non-Responses native failure/cancellation from arbitrary reason strings', () => {
    for (const from of ['chat', 'messages'] as const) for (const rawReason of ['failed', 'cancelled', 'content_filter_extension']) {
      expect(value(normalizeFinish({ from, rawReason })).terminal).toMatchObject({ status: 'incomplete', reason: 'unknown' });
    }
  });
  it('retains Responses status and incomplete detail separately', () => {
    expect(value(normalizeFinish({ from: 'responses', rawReason: 'incomplete', incompleteReason: 'max_output_tokens' })))
      .toMatchObject({ rawReason: 'incomplete', incompleteReason: 'max_output_tokens', terminal: { upstreamReason: 'max_output_tokens' } });
  });
  it('retains truncation even when partial output includes a refusal', () => {
    expect(value(normalizeFinish({ from: 'chat', rawReason: 'length', hasRefusal: true })).terminal)
      .toMatchObject({ status: 'incomplete', reason: 'length' });
  });
  it.each(['', 'reason\nsecret', '<script>', 'x'.repeat(129)])('rejects malformed reason %# without reflecting it', rawReason => {
    const result = normalizeFinish({ from: 'chat', rawReason });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_finish_reason' } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('target terminal matrix', () => {
  it.each(sourceMatrix)('maps %j without turning %s/%s into normal success', (input, status, reason) => {
    const source = value(normalizeFinish(input));
    for (const to of protocols) {
      const mapped = mapFinishToTarget(source, to);
      if (reason === 'refusal' && to !== 'messages') {
        expect(mapped).toMatchObject({ ok: false, error: { code: 'refusal_payload_required' } });
        continue;
      }
      const result = value(mapped);
      expect(result.to).toBe(to);
      expect(result.source).toEqual(source);
      if (reason === 'unknown' || (reason === 'content_filter' && to === 'messages')) {
        expect(result.kind).toBe('error'); continue;
      }
      expect(result.kind).toBe('native');
      if (status === 'completed') {
        const targetFields = to === 'chat' ? { finish_reason: reason === 'stop' ? 'stop' : 'tool_calls' }
          : to === 'messages' ? { stop_reason: reason === 'stop' ? 'end_turn' : 'tool_use' }
          : { status: 'completed', incomplete_details: null };
        expect(result).toMatchObject(targetFields);
      } else if (reason === 'length') {
        if (to === 'chat') expect(result).toHaveProperty('finish_reason', 'length');
        if (to === 'messages') expect(result).toHaveProperty('stop_reason', input.rawReason === 'model_context_window_exceeded' ? 'model_context_window_exceeded' : 'max_tokens');
        if (to === 'responses') expect(result).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
      } else if (reason === 'refusal') expect(result).toHaveProperty('stop_reason', 'refusal');
      else if (reason === 'content_filter') expect(result).toMatchObject(to === 'chat' ? { finish_reason: 'content_filter' } : { status: 'incomplete', incomplete_details: { reason: 'content_filter' } });
    }
  });
  it.each(protocols)('keeps all target failure/cancellation/EOF paths distinct for %s', from => {
    const error: ProtocolError = { kind: 'upstream_error', code: 'safe_failure', message: 'Safe failure.' };
    for (const to of protocols) {
      expect(value(mapFinishToTarget(value(normalizeFinish({ from, rawReason: null, event: 'failed', error })), to)))
        .toMatchObject({ kind: 'error', to, error });
      expect(value(mapFinishToTarget(value(normalizeFinish({ from, rawReason: null, event: 'cancelled' })), to)))
        .toMatchObject({ kind: 'cancelled', to });
      expect(value(mapFinishToTarget(value(normalizeFinish({ from, rawReason: null, event: 'eof' })), to)))
        .toMatchObject({ kind: 'error', to, error: { kind: 'stream_error', code: 'unexpected_eof' } });
    }
  });
  it.each(protocols)('requires actual refusal payload from %s for Chat/Responses plans', from => {
    const rawReason = from === 'chat' ? 'stop' : from === 'responses' ? 'completed' : 'refusal';
    const source = value(normalizeFinish({ from, rawReason, hasRefusal: true }));
    for (const to of ['chat', 'responses'] as const) {
      expect(mapFinishToTarget(source, to)).toMatchObject({ ok: false, error: { code: 'refusal_payload_required' } });
      const payload = Object.freeze({ refusal: 'Synthetic refusal evidence.' });
      const plan = value(mapFinishToTarget(source, to, { refusalPayload: payload }));
      expect(plan).toMatchObject({ kind: 'refusal', to, requiresRefusalPayload: true, refusalPayload: payload,
        source: { terminal: { status: 'incomplete', reason: 'refusal' } } });
      expect(plan).toMatchObject(to === 'chat' ? { finish_reason: 'stop', refusalField: 'message.refusal' }
        : { status: 'completed', refusalField: 'output[].content[].refusal' });
      expect(plan).not.toHaveProperty('content');
      expect(plan).not.toHaveProperty('text');
    }
    expect(value(mapFinishToTarget(source, 'messages'))).toMatchObject({ kind: 'native', stop_reason: 'refusal' });
  });
  it('does not reclassify normal/truncated output just because target options have a payload', () => {
    for (const rawReason of ['stop', 'length']) {
      const source = value(normalizeFinish({ from: 'chat', rawReason }));
      expect(value(mapFinishToTarget(source, 'chat', { refusalPayload: { refusal: 'Unused' } })).kind).toBe('native');
    }
  });
  it('has no usage or HTTP inputs and mutates neither source nor sanitized errors', () => {
    const input = Object.freeze({ from: 'chat' as const, rawReason: 'length' });
    const normalized = value(normalizeFinish(input));
    Object.freeze(normalized.terminal); Object.freeze(normalized);
    const before = JSON.stringify(normalized);
    for (const to of protocols) expect(mapFinishToTarget(normalized, to).ok).toBe(true);
    expect(JSON.stringify(normalized)).toBe(before);
    expect(normalized).not.toHaveProperty('usage');
    expect(normalized).not.toHaveProperty('cost');
  });
});
