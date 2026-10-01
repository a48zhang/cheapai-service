import { describe, expect, it } from 'vitest';
import { createResponsesUsageSession, extractResponsesUsage, responsesUsageExtractor } from '../../../packages/apicompat/usage/responses.js';
import type { TerminalState } from '../../../packages/apicompat/types/shared.js';

const completed: TerminalState = { status: 'completed', reason: 'stop' };
const eof: TerminalState = { status: 'incomplete', reason: 'unexpected_eof' };
const usage = { input_tokens: 20, output_tokens: 8, total_tokens: 28,
  input_tokens_details: { cached_tokens: 12, cache_write_tokens: 3 }, output_tokens_details: { reasoning_tokens: 5 } };
const event = (type: string, value: unknown, sequence_number?: number) => ({ type, response: { usage: value }, ...(sequence_number === undefined ? {} : { sequence_number }) });

describe('Responses original usage extraction', () => {
  it('uses provider totals without adding cache or reasoning subsets', () => {
    const result = responsesUsageExtractor.json({ usage, output: [{ content: 'irrelevant' }], secret: 'never retain' });
    expect(result).toMatchObject({ quality: 'complete', counts: {
      inputTokens: 20, outputTokens: 8, totalTokens: 28, cacheReadTokens: 12, cacheWriteTokens: 3, reasoningTokens: 5,
    }, semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'unknown' },
    sources: [{ protocol: 'responses', path: 'usage', raw: usage }], issues: [] });
    expect(JSON.stringify(result)).not.toContain('never retain');
    expect(JSON.stringify(result)).not.toContain('irrelevant');
  });

  it.each([undefined, null, {}, { usage: null }, { output_text: 'long generated answer' }])('keeps absent usage missing: %#', input => {
    expect(extractResponsesUsage(input)).toEqual({ quality: 'missing', protocol: 'responses' });
  });

  it('distinguishes empty/partial evidence, real zero and nonfinal JSON usage', () => {
    expect(extractResponsesUsage({ usage: {} })).toMatchObject({ quality: 'partial', counts: {}, issues: ['missing_input_tokens', 'missing_output_tokens'] });
    expect(extractResponsesUsage({ usage: { output_tokens: 0 } })).toMatchObject({ quality: 'partial', counts: { outputTokens: 0 } });
    expect(extractResponsesUsage({ usage: { input_tokens: 0, output_tokens: 0 } })).toMatchObject({ quality: 'complete', counts: { inputTokens: 0, outputTokens: 0 } });
    expect(extractResponsesUsage({ status: 'in_progress', usage })).toMatchObject({ quality: 'partial', issues: ['missing_final_usage'] });
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', null, undefined])('marks abnormal counters invalid: %#', count => {
    const result = extractResponsesUsage({ usage: { input_tokens: count, output_tokens: 1 } });
    expect(result).toMatchObject({ quality: 'invalid', counts: { outputTokens: 1 }, issues: expect.arrayContaining(['invalid_input_tokens']) });
    if (result.quality !== 'missing') expect(result.counts.inputTokens).toBeUndefined();
  });

  it.each([
    [false, 'invalid_usage_object'], [[], 'invalid_usage_object'],
    [{ input_tokens_details: null }, 'invalid_input_tokens_details'],
    [{ output_tokens_details: { reasoning_tokens: -1 } }, 'invalid_reasoning_tokens'],
    [{ input_tokens: 1, output_tokens: 2, total_tokens: 4 }, 'total_tokens_mismatch'],
    [{ input_tokens: 10, total_tokens: 1 }, 'total_tokens_below_component'],
    [{ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }, 'unsafe_combined_total'],
    [{ input_tokens: 2, input_tokens_details: { cached_tokens: 3 } }, 'cached_tokens_exceed_input'],
    [{ input_tokens: 2, input_tokens_details: { cache_write_tokens: 3 } }, 'cache_write_tokens_exceed_input'],
    [{ input_tokens: 3, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 2 } }, 'cache_components_exceed_input'],
    [{ output_tokens: 1, output_tokens_details: { reasoning_tokens: 2 } }, 'reasoning_tokens_exceed_output'],
  ])('reports inconsistent evidence %#', (value, issue) => {
    expect(extractResponsesUsage({ usage: value })).toMatchObject({ quality: 'invalid', issues: expect.arrayContaining([issue]) });
  });

  it('copies bounded raw evidence without retaining a mutable provider body', () => {
    const provider = { usage: structuredClone(usage), input: 'secret' };
    const result = extractResponsesUsage(provider);
    provider.usage.input_tokens = 999;
    expect(result).toMatchObject({ counts: { inputTokens: 20 }, sources: [{ raw: { input_tokens: 20 } }] });
    const large = extractResponsesUsage({ usage: { ...usage, vendor_detail: 'x'.repeat(10_000) } });
    expect(large.quality).toBe('complete');
    if (large.quality !== 'missing') expect(large.sources[0]?.raw).toBeUndefined();
    const circular: Record<string, unknown> = { ...usage }; circular.self = circular;
    expect(extractResponsesUsage({ usage: circular }).quality).toBe('complete');
  });
});

describe('Responses streaming usage', () => {
  it.each(['response.completed', 'response.failed', 'response.incomplete'])('extracts final usage from %s independently of execution success', type => {
    const session = responsesUsageExtractor.createStream();
    const updates = session.push({ data: JSON.stringify(event(type, usage, 0)), event: type });
    expect(updates).toMatchObject([{ sequence: 1, mode: 'cumulative', final: true, counts: { inputTokens: 20, outputTokens: 8 }, source: { path: 'response.usage', eventType: type } }]);
    const terminal: TerminalState = type === 'response.failed'
      ? { status: 'failed', error: { kind: 'upstream_error', code: 'test', message: 'safe' } }
      : type === 'response.incomplete' ? { status: 'incomplete', reason: 'length' } : completed;
    expect(session.finish(terminal)).toMatchObject({ quality: 'complete', counts: { totalTokens: 28 } });
  });

  it('replaces cumulative observations rather than adding them, preserving omitted fields', () => {
    const session = createResponsesUsageSession();
    expect(session.push(event('response.in_progress', { input_tokens: 20, input_tokens_details: { cached_tokens: 12 } }, 1))).toMatchObject([{ sequence: 1, mode: 'cumulative', final: false }]);
    expect(session.push(event('response.in_progress', { output_tokens: 3 }, 2))).toMatchObject([{ sequence: 2, counts: { outputTokens: 3 } }]);
    session.push(event('response.completed', { input_tokens: 20, output_tokens: 8, total_tokens: 28 }, 3));
    expect(session.finish(completed)).toMatchObject({ quality: 'complete', counts: { inputTokens: 20, outputTokens: 8, totalTokens: 28, cacheReadTokens: 12 } });
  });

  it('ignores replayed/out-of-order events and deduplicates observations without provider sequence', () => {
    const session = createResponsesUsageSession();
    const first = event('response.in_progress', { input_tokens: 20 }, 2);
    expect(session.push(first)).toHaveLength(1);
    expect(session.push(first)).toEqual([]);
    expect(session.push(event('response.in_progress', { input_tokens: 1 }, 1))).toEqual([]);
    expect(session.push(event('response.in_progress', { input_tokens: 20 }))).toEqual([]);
    session.push(event('response.completed', usage, 3));
    expect(session.finish(completed).quality).toBe('complete');
  });

  it('does not infer usage from text/arguments deltas, unknown usage deltas, DONE, or caller success', () => {
    const session = createResponsesUsageSession();
    for (const input of [ { type: 'response.output_text.delta', delta: 'many tokens', usage },
      { type: 'response.function_call_arguments.delta', delta: '{}' },
      { type: 'response.usage.delta', usage }, { data: '[DONE]' }, { data: '{bad json' } ]) expect(session.push(input)).toEqual([]);
    expect(session.finish(completed)).toEqual({ quality: 'missing', protocol: 'responses' });
  });

  it('leaves nonfinal or absent terminal usage partial and never erases known counts', () => {
    for (const terminalEvent of [undefined, event('response.completed', null), event('response.completed', {}), event('response.completed', { input_tokens: 20 })]) {
      const session = createResponsesUsageSession();
      session.push(event('response.in_progress', usage));
      if (terminalEvent) session.push(terminalEvent);
      expect(session.finish(eof)).toMatchObject({ quality: 'partial', counts: { inputTokens: 20, outputTokens: 8 }, issues: ['missing_final_usage'] });
    }
  });

  it('keeps invalid evidence sticky through subsequent valid usage and flags regressing counts', () => {
    const session = createResponsesUsageSession();
    session.push(event('response.in_progress', { input_tokens: 20, output_tokens: -1 }, 1));
    session.push(event('response.completed', { input_tokens: 10, output_tokens: 8, total_tokens: 18 }, 2));
    expect(session.finish(completed)).toMatchObject({ quality: 'invalid', issues: expect.arrayContaining(['invalid_output_tokens', 'regressed_inputTokens']) });
  });

  it('retains at most one source per native event and bounded raw data after many observations', () => {
    const session = createResponsesUsageSession();
    for (let i = 0; i < 300; i++) session.push(event('response.in_progress', { input_tokens: i, output_tokens: 0 }, i));
    session.push(event('response.completed', { input_tokens: 299, output_tokens: 0 }, 300));
    const result = session.finish(completed);
    expect(result.quality).toBe('complete');
    if (result.quality !== 'missing') {
      expect(result.sources).toHaveLength(2);
      expect(JSON.stringify(result).length).toBeLessThan(4096);
    }
  });

  it('returns one frozen final snapshot and ignores all late input and repeated finish calls', () => {
    const session = createResponsesUsageSession();
    session.push(event('response.completed', usage));
    expect(session.push(event('response.completed', { input_tokens: 999 }))).toEqual([]);
    const first = session.finish(completed);
    expect(session.push(event('response.in_progress', { input_tokens: 999 }))).toEqual([]);
    expect(session.finish(eof)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    if (first.quality !== 'missing') {
      expect(Object.isFrozen(first.counts)).toBe(true);
      expect(Object.isFrozen(first.sources)).toBe(true);
    }
  });
});
