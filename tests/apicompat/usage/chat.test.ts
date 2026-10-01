import { describe, expect, it } from 'vitest';
import { chatUsageExtractor, createChatUsageSession, extractChatUsage } from '../../../packages/apicompat/usage/chat.js';
import type { TerminalState } from '../../../packages/apicompat/types/shared.js';

const complete: TerminalState = { status: 'completed', reason: 'stop' };
const eof: TerminalState = { status: 'incomplete', reason: 'unexpected_eof' };
const usage = { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27,
  prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 4 } };
const chunk = (value: unknown, choices: readonly unknown[] = []) => ({ id: 'same-id-on-all-chunks', object: 'chat.completion.chunk', choices, usage: value });

describe('Chat original JSON usage', () => {
  it('retains prompt/completion totals and included subsets without adding them', () => {
    expect(chatUsageExtractor.json({ usage, choices: [{ message: { content: 'must not be retained' } }], secret: 'never copy' })).toMatchObject({
      quality: 'complete', protocol: 'chat', counts: { inputTokens: 20, outputTokens: 7, totalTokens: 27, cacheReadTokens: 10, reasoningTokens: 4 },
      semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'unknown' },
      sources: [{ protocol: 'chat', path: 'usage', raw: usage }], issues: [],
    });
    expect(JSON.stringify(extractChatUsage({ usage, secret: 'never copy' }))).not.toContain('never copy');
  });

  it('does not invent absent detail fields or totals and preserves genuine zero', () => {
    const result = extractChatUsage({ usage: { prompt_tokens: 0, completion_tokens: 0 } });
    expect(result).toMatchObject({ quality: 'complete', counts: { inputTokens: 0, outputTokens: 0 } });
    if (result.quality !== 'missing') {
      expect(result.counts).not.toHaveProperty('cacheReadTokens');
      expect(result.counts).not.toHaveProperty('cacheWriteTokens');
      expect(result.counts).not.toHaveProperty('reasoningTokens');
      expect(result.counts).not.toHaveProperty('totalTokens');
    }
  });

  it.each([null, undefined, {}, { usage: null }, { choices: [{ message: { content: 'word word word' } }] }])('keeps missing usage distinct %#', input => {
    expect(extractChatUsage(input)).toEqual({ quality: 'missing', protocol: 'chat' });
  });

  it.each([{}, { prompt_tokens: 5 }, { total_tokens: 10 }, { completion_tokens_details: { reasoning_tokens: 2 } }])('retains partial evidence %#', value => {
    expect(extractChatUsage({ usage: value }).quality).toBe('partial');
  });

  it.each([-1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '4', null, undefined])('rejects invalid counts %# without inventing zero', count => {
    const result = extractChatUsage({ usage: { prompt_tokens: count, completion_tokens: 3 } });
    expect(result).toMatchObject({ quality: 'invalid', counts: { outputTokens: 3 }, issues: expect.arrayContaining(['invalid_prompt_tokens']) });
    if (result.quality !== 'missing') expect(result.counts).not.toHaveProperty('inputTokens');
  });

  it.each([
    [false, 'invalid_usage_object'], [[], 'invalid_usage_object'],
    [{ prompt_tokens_details: null }, 'invalid_prompt_tokens_details'],
    [{ completion_tokens_details: { reasoning_tokens: -1 } }, 'invalid_reasoning_tokens'],
    [{ prompt_tokens: 2, completion_tokens: 3, total_tokens: 9 }, 'total_tokens_mismatch'],
    [{ prompt_tokens: 3, total_tokens: 2 }, 'total_tokens_below_component'],
    [{ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 }, 'unsafe_combined_total'],
    [{ prompt_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } }, 'cached_tokens_exceed_input'],
    [{ completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 2 } }, 'reasoning_tokens_exceed_output'],
  ])('rejects contradictory usage %#', (value, issue) => {
    expect(extractChatUsage({ usage: value })).toMatchObject({ quality: 'invalid', issues: expect.arrayContaining([issue]) });
  });

  it('bounds and detaches raw usage evidence from the provider object', () => {
    const source = structuredClone(usage);
    const result = extractChatUsage({ usage: source }); source.prompt_tokens = 123;
    expect(result).toMatchObject({ sources: [{ raw: { prompt_tokens: 20 } }] });
    const huge = extractChatUsage({ usage: { ...usage, extension: 'x'.repeat(5000) } });
    expect(huge.quality).toBe('complete');
    if (huge.quality !== 'missing') expect(huge.sources[0]?.raw).toBeUndefined();
  });
});

describe('Chat cumulative streaming usage', () => {
  it('accepts the usage-only chunk after finish_reason and seals at DONE', () => {
    const session = createChatUsageSession();
    expect(session.push(chunk(null, [{ index: 0, delta: {}, finish_reason: 'stop' }]))).toEqual([]);
    expect(session.push({ data: JSON.stringify(chunk(usage)) })).toMatchObject([{ sequence: 1, mode: 'cumulative', final: true, counts: { inputTokens: 20, outputTokens: 7 } }]);
    expect(session.push({ data: '[DONE]' })).toEqual([]);
    expect(session.finish(complete)).toMatchObject({ quality: 'complete', counts: { totalTokens: 27 } });
  });

  it('does not confuse multi-choice completion or one shared response id with usage finality', () => {
    const session = createChatUsageSession();
    session.push(chunk({ prompt_tokens: 20 }, [{ index: 0, finish_reason: 'stop' }, { index: 1, finish_reason: null }]));
    session.push(chunk({ completion_tokens: 3 }, [{ index: 1, finish_reason: 'tool_calls' }]));
    session.push(chunk(usage)); session.push('[DONE]');
    expect(session.finish(complete)).toMatchObject({ quality: 'complete', counts: { inputTokens: 20, outputTokens: 7, totalTokens: 27 } });
  });

  it('replaces cumulative values, retains omitted counts, and does not sum repeated observations', () => {
    const session = createChatUsageSession();
    session.push(chunk({ prompt_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } }, [{}]));
    session.push(chunk({ completion_tokens: 2 }, [{}]));
    session.push(chunk({ prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 }));
    expect(session.push(chunk({ prompt_tokens: 20, completion_tokens: 7, total_tokens: 27 }))).toEqual([]);
    session.push('[DONE]');
    expect(session.finish(complete)).toMatchObject({ quality: 'complete', counts: { inputTokens: 20, outputTokens: 7, cacheReadTokens: 10 } });
  });

  it('marks regressing or contradictory usage invalid even when a later observation is valid', () => {
    const session = createChatUsageSession();
    session.push(chunk({ prompt_tokens: 20, completion_tokens: -1 }, [{}]));
    session.push(chunk({ prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 })); session.push('[DONE]');
    expect(session.finish(complete)).toMatchObject({ quality: 'invalid', issues: expect.arrayContaining(['invalid_completion_tokens', 'regressed_inputTokens']) });
  });

  it('keeps an early EOF partial even when a choice ended or caller reports completion', () => {
    for (const terminal of [eof, complete, { status: 'cancelled' } as const]) {
      const session = createChatUsageSession();
      session.push(chunk(usage, [{ index: 0, finish_reason: 'stop' }]));
      expect(session.finish(terminal)).toMatchObject({ quality: 'partial', counts: { inputTokens: 20, outputTokens: 7 }, issues: ['missing_final_usage'] });
    }
  });

  it('keeps final usage-only accounting complete when DONE is lost or the client cancels', () => {
    for (const terminal of [eof, { status: 'cancelled' } as const, { status: 'failed', error: { kind: 'stream_error', code: 'disconnect', message: 'Disconnected' } } as const]) {
      const session = createChatUsageSession(); session.push(chunk(usage));
      expect(session.finish(terminal)).toMatchObject({ quality: 'complete', counts: { inputTokens: 20, outputTokens: 7 }, issues: [] });
    }
    // DONE after an ordinary chunk proves stream closure, not final accounting.
    const early = createChatUsageSession(); early.push(chunk(usage, [{ index: 0, finish_reason: 'stop' }])); early.push('[DONE]');
    expect(early.finish(complete)).toMatchObject({ quality: 'partial', issues: ['missing_final_usage'] });
  });

  it('does not upgrade missing/partial usage just because DONE arrived', () => {
    const missing = createChatUsageSession(); missing.push('[DONE]');
    expect(missing.finish(complete)).toEqual({ quality: 'missing', protocol: 'chat' });
    const partial = createChatUsageSession(); partial.push(chunk({ prompt_tokens: 5 })); partial.push('[DONE]');
    expect(partial.finish(complete)).toMatchObject({ quality: 'partial', counts: { inputTokens: 5 } });
    const stale = createChatUsageSession(); stale.push(chunk(usage, [{}])); stale.push(chunk({})); stale.push('[DONE]');
    expect(stale.finish(complete)).toMatchObject({ quality: 'partial', counts: { inputTokens: 20 } });
  });

  it('ignores text, tool argument deltas and foreign usage objects', () => {
    const session = createChatUsageSession();
    for (const input of [chunk(null, [{ delta: { content: 'long answer' }, finish_reason: null }]),
      chunk(null, [{ delta: { tool_calls: [{ function: { arguments: '{"a":' } }] }, finish_reason: null }]),
      { type: 'response.completed', response: { usage } }, { usage }, { data: 'not-json' }]) expect(session.push(input)).toEqual([]);
    session.push('[DONE]'); expect(session.finish(complete).quality).toBe('missing');
  });

  it('bounds evidence across hundreds of chunks and uses local increasing sequences', () => {
    const session = createChatUsageSession();
    for (let i = 0; i < 300; i++) {
      expect(session.push(chunk({ prompt_tokens: 20, completion_tokens: i }, [{}]))[0]?.sequence).toBe(i + 1);
    }
    session.push(chunk({ prompt_tokens: 20, completion_tokens: 299 })); session.push('[DONE]');
    const result = session.finish(complete);
    expect(result.quality).toBe('complete');
    if (result.quality !== 'missing') { expect(result.sources).toHaveLength(2); expect(JSON.stringify(result).length).toBeLessThan(4096); }
  });

  it('seals DONE and finish idempotently, returning one frozen snapshot', () => {
    const session = createChatUsageSession(); session.push(chunk(usage)); session.push('[DONE]');
    expect(session.push('[DONE]')).toEqual([]);
    expect(session.push(chunk({ prompt_tokens: 999 }))).toEqual([]);
    const first = session.finish(complete); expect(session.finish(eof)).toBe(first);
    expect(session.push(chunk(usage))).toEqual([]);
    expect(Object.isFrozen(first)).toBe(true);
    const early = createChatUsageSession(); const stopped = early.finish(eof);
    expect(early.push(chunk(usage))).toEqual([]); expect(early.finish(complete)).toBe(stopped);
  });
});
