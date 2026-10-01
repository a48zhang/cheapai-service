import { describe, expect, it } from 'vitest';
import { createMessagesUsageSession, extractMessagesUsage, messagesUsageExtractor } from '../../../packages/apicompat/usage/messages.js';
import type { TerminalState } from '../../../packages/apicompat/types/shared.js';

const complete: TerminalState = { status: 'completed', reason: 'stop' };
const cancelled: TerminalState = { status: 'cancelled' };
const eof: TerminalState = { status: 'incomplete', reason: 'unexpected_eof' };
const usage = { input_tokens: 4, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 30,
  cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }, output_tokens_details: { thinking_tokens: 6 } };
const start = (value: unknown) => ({ type: 'message_start', message: { usage: value, content: [], stop_reason: null } });
const delta = (value: unknown, stop_reason: string | null = 'end_turn') => ({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: value });

describe('Messages original JSON usage', () => {
  it('accepts standard neutral metadata and explicit optional/zero server-tool evidence without inventing buckets', () => {
    // Official schema fields: https://platform.claude.com/docs/en/api/messages/create
    // Metadata presentation stays separate from the fixed token selling-price table.
    for (const server_tool_use of [null, { web_fetch_requests: 0, web_search_requests: 0 }]) {
      const result = extractMessagesUsage({ usage: { ...usage, service_tier: 'standard', inference_geo: 'global', server_tool_use } });
      expect(result).toMatchObject({ quality: 'complete', issues: [], sources: [{ raw: { server_tool_use } }] });
      if (result.quality !== 'missing') expect(Object.keys(result.counts)).not.toContain('serverToolCalls');
      expect(JSON.stringify(result)).not.toContain('service_tier');
    }
    expect(extractMessagesUsage({ usage: { ...usage, service_tier: null, inference_geo: null } }).quality).toBe('complete');
  });

  it('refuses precise pricing evidence for nonzero, missing, unknown or malformed server-tool counts', () => {
    for (const [server_tool_use, issue] of [
      [{ web_fetch_requests: 1, web_search_requests: 0 }, 'unsupported_server_tool_usage'],
      [{ web_fetch_requests: 0, web_search_requests: 1 }, 'unsupported_server_tool_usage'],
      [{ web_fetch_requests: 0 }, 'unknown_server_tool_usage'],
      [{ web_fetch_requests: null, web_search_requests: 0 }, 'unknown_server_tool_usage'],
      [{ web_fetch_requests: 0, web_search_requests: 0, another_billable_tool: 1 }, 'unknown_server_tool_usage'],
      [{ web_fetch_requests: -1, web_search_requests: 0 }, 'invalid_server_tool_usage'],
      [{ web_fetch_requests: 'private-secret', web_search_requests: 0 }, 'invalid_server_tool_usage'],
      [[], 'invalid_server_tool_usage'],
    ] as const) {
      const result = extractMessagesUsage({ usage: { ...usage, server_tool_use } });
      expect(result).toMatchObject({ quality: 'invalid', issues: expect.arrayContaining([issue]) });
      expect(JSON.stringify(result)).not.toContain('private-secret');
      expect(JSON.stringify(result)).not.toContain('another_billable_tool');
    }
    for (const metadata of [{ service_tier: {} }, { service_tier: 'imaginary' }, { inference_geo: { secret: 'do-not-copy' } }]) {
      const result = extractMessagesUsage({ usage: { ...usage, ...metadata } });
      expect(result.quality).toBe('invalid'); expect(JSON.stringify(result)).not.toContain('do-not-copy');
    }
  });

  it('keeps observed nonzero server-tool work invalid even if a later stream update reports zero', () => {
    const session = createMessagesUsageSession();
    session.push(start({ ...usage, output_tokens: 0, output_tokens_details: { thinking_tokens: 0 }, server_tool_use: { web_fetch_requests: 1, web_search_requests: 0 } }));
    session.push(delta({ output_tokens: 9, server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 } }));
    expect(session.finish(complete)).toMatchObject({ quality: 'invalid', issues: expect.arrayContaining(['unsupported_server_tool_usage']) });
  });
  it('keeps cache read/write outside native input and TTL/reasoning as included subsets', () => {
    expect(messagesUsageExtractor.json({ usage, stop_reason: 'end_turn', content: [{ text: 'never retain' }] })).toMatchObject({
      quality: 'complete', protocol: 'messages', counts: { inputTokens: 4, outputTokens: 9, cacheReadTokens: 100, cacheWriteTokens: 30,
        cacheWrite5mTokens: 10, cacheWrite1hTokens: 20, reasoningTokens: 6 },
      semantics: { cacheRead: 'excluded_from_input', cacheWrite: 'excluded_from_input', reasoning: 'included_in_output', cacheWriteTtl: 'subsets_of_cache_write' },
      sources: [{ path: 'usage', raw: usage }], issues: [],
    });
    // Cache counts can exceed ordinary input_tokens. Neither TTL nor thinking is added again.
    const result = extractMessagesUsage({ usage });
    if (result.quality !== 'missing') expect(result.counts).not.toHaveProperty('totalTokens');
  });

  it.each([undefined, null, {}, { usage: null }, { content: [{ type: 'thinking', thinking: 'secret' }] }])('keeps absent evidence missing %#', input => {
    expect(extractMessagesUsage(input)).toEqual({ quality: 'missing', protocol: 'messages' });
  });

  it('requires explicit excluded cache aggregates without inferring zero or summing TTLs', () => {
    const partial = extractMessagesUsage({ usage: { input_tokens: 1, output_tokens: 2 } });
    expect(partial).toMatchObject({ quality: 'partial', counts: { inputTokens: 1, outputTokens: 2 }, issues: ['missing_cache_read_input_tokens', 'missing_cache_creation_input_tokens'] });
    const ttl = extractMessagesUsage({ usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 } } });
    expect(ttl).toMatchObject({ quality: 'partial', issues: ['missing_cache_creation_input_tokens'] });
    if (ttl.quality !== 'missing') expect(ttl.counts).not.toHaveProperty('cacheWriteTokens');
  });

  it('preserves real zero and does not require optional TTL/thinking splits', () => {
    const result = extractMessagesUsage({ usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    expect(result).toMatchObject({ quality: 'complete', counts: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, issues: [] });
    if (result.quality !== 'missing') {
      expect(result.counts).not.toHaveProperty('cacheWrite5mTokens'); expect(result.counts).not.toHaveProperty('reasoningTokens');
    }
  });

  it('keeps nullable unavailable fields partial rather than silently zero', () => {
    expect(extractMessagesUsage({ usage: { ...usage, cache_creation_input_tokens: null, cache_creation: null } })).toMatchObject({ quality: 'partial', issues: ['missing_cache_creation_input_tokens'] });
    expect(extractMessagesUsage({ usage, stop_reason: null })).toMatchObject({ quality: 'partial', issues: ['missing_final_usage'] });
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'secret-counter'])('marks bad counts invalid %# without copying text into evidence', value => {
    const result = extractMessagesUsage({ usage: { ...usage, input_tokens: value } });
    expect(result).toMatchObject({ quality: 'invalid', issues: expect.arrayContaining(['invalid_input_tokens']) });
    expect(JSON.stringify(result)).not.toContain('secret-counter');
  });

  it.each([
    [false, 'invalid_usage_object'], [[], 'invalid_usage_object'],
    [{ ...usage, cache_creation: 'bad' }, 'invalid_cache_creation'],
    [{ ...usage, output_tokens_details: { thinking_tokens: -1 } }, 'invalid_thinking_tokens'],
    [{ ...usage, output_tokens_details: { thinking_tokens: 10 } }, 'thinking_tokens_exceed_output'],
    [{ ...usage, cache_creation: { ephemeral_5m_input_tokens: 31 } }, 'cache_ttl_exceeds_aggregate'],
    [{ ...usage, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 21 } }, 'cache_ttl_aggregate_mismatch'],
    [{ ...usage, cache_creation: { ephemeral_5m_input_tokens: Number.MAX_SAFE_INTEGER, ephemeral_1h_input_tokens: 1 } }, 'unsafe_cache_ttl_sum'],
    [{ ...usage, input_tokens: Number.MAX_SAFE_INTEGER }, 'unsafe_combined_total'],
  ])('reports malformed or contradictory evidence %#', (value, issue) => {
    expect(extractMessagesUsage({ usage: value })).toMatchObject({ quality: 'invalid', issues: expect.arrayContaining([issue]) });
  });

  it('retains only a fixed redacted counter allowlist and detaches evidence', () => {
    const body = { usage: { ...structuredClone(usage), authorization: 'secret', extension: 'x'.repeat(100_000) }, secret: 'header', content: [{ text: 'prompt' }] };
    const result = extractMessagesUsage(body); body.usage.input_tokens = 999;
    expect(result).toMatchObject({ sources: [{ raw: usage }] });
    expect(JSON.stringify(result)).not.toMatch(/authorization|secret|header|prompt|extension/);
    expect(JSON.stringify(result).length).toBeLessThan(2048);
  });
});

describe('Messages cumulative streaming usage', () => {
  it('combines message_start input/cache with final message_delta output without adding deltas', () => {
    const session = createMessagesUsageSession();
    expect(session.push(start({ ...usage, output_tokens: 0, output_tokens_details: undefined }))).toMatchObject([{ sequence: 1, mode: 'cumulative', final: false }]);
    expect(session.push(delta({ output_tokens: 3 }, null))).toMatchObject([{ sequence: 2, mode: 'cumulative', counts: { outputTokens: 3 }, final: false }]);
    expect(session.push(delta({ output_tokens: 9, output_tokens_details: { thinking_tokens: 6 } }))).toMatchObject([{ sequence: 3, mode: 'cumulative', counts: { outputTokens: 9, reasoningTokens: 6 }, final: true }]);
    expect(session.finish(complete)).toMatchObject({ quality: 'complete', counts: { inputTokens: 4, outputTokens: 9, cacheReadTokens: 100, cacheWriteTokens: 30 } });
  });

  it('keeps complete measured usage after cancellation, error or missing message_stop', () => {
    for (const terminal of [cancelled, eof, { status: 'failed', error: { kind: 'stream_error', code: 'disconnect', message: 'Disconnected' } } as const]) {
      const session = createMessagesUsageSession();
      session.push({ data: JSON.stringify(start({ ...usage, output_tokens: 0, output_tokens_details: null })) });
      session.push({ data: JSON.stringify(delta({ output_tokens: 9 })) });
      expect(session.finish(terminal)).toMatchObject({ quality: 'complete', counts: { outputTokens: 9 }, issues: [] });
    }
  });

  it('does not upgrade message_start output or caller completion to final usage', () => {
    for (const stop of [false, true]) {
      const session = createMessagesUsageSession(); session.push(start(usage));
      if (stop) session.push({ type: 'message_stop' });
      expect(session.finish(complete)).toMatchObject({ quality: 'partial', issues: ['missing_final_usage'] });
    }
  });

  it('allows native message_stop to finalize a valid latest output delta but does not invent missing usage', () => {
    const session = createMessagesUsageSession(); session.push(start({ ...usage, output_tokens: 0, output_tokens_details: null }));
    session.push(delta({ output_tokens: 9 }, null));
    expect(session.push({ type: 'message_stop' })).toMatchObject([{ mode: 'cumulative', final: true }]);
    expect(session.finish(complete).quality).toBe('complete');
    const missing = createMessagesUsageSession(); missing.push({ type: 'message_stop' }); expect(missing.finish(complete).quality).toBe('missing');
  });

  it('keeps missing input/cache partial even if a final delta supplies output', () => {
    const session = createMessagesUsageSession(); session.push(delta({ output_tokens: 0 }));
    expect(session.finish(complete)).toMatchObject({ quality: 'partial', counts: { outputTokens: 0 }, issues: expect.arrayContaining(['missing_input_tokens', 'missing_cache_read_input_tokens']) });
  });

  it('flags regressions and keeps invalid early observations sticky', () => {
    const session = createMessagesUsageSession(); session.push(start({ ...usage, output_tokens: 0, output_tokens_details: null }));
    session.push(delta({ output_tokens: 8, cache_read_input_tokens: -1 }, null));
    session.push(delta({ output_tokens: 7 }));
    expect(session.finish(complete)).toMatchObject({ quality: 'invalid', issues: expect.arrayContaining(['invalid_cache_read_input_tokens', 'regressed_outputTokens']) });
  });

  it('does not infer counts from text, signatures or thinking deltas', () => {
    const session = createMessagesUsageSession();
    for (const input of [{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'secret' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }, { type: 'ping' }, { data: '{broken' }]) expect(session.push(input)).toEqual([]);
    expect(session.finish(complete)).toEqual({ quality: 'missing', protocol: 'messages' });
  });

  it('bounds evidence to two sources and does not add cumulative cache TTLs', () => {
    const session = createMessagesUsageSession(); session.push(start({ ...usage, output_tokens: 0, output_tokens_details: null }));
    for (let i = 0; i < 200; i++) session.push(delta({ output_tokens: i, cache_creation: usage.cache_creation }, null));
    session.push(delta({ output_tokens: 199 }));
    const result = session.finish(complete);
    expect(result).toMatchObject({ quality: 'complete', counts: { outputTokens: 199, cacheWriteTokens: 30, cacheWrite5mTokens: 10, cacheWrite1hTokens: 20 } });
    if (result.quality !== 'missing') { expect(result.sources).toHaveLength(2); expect(JSON.stringify(result).length).toBeLessThan(2048); }
  });

  it('deduplicates final usage, seals message_stop and returns one immutable snapshot', () => {
    const session = createMessagesUsageSession(); session.push(start({ ...usage, output_tokens: 0, output_tokens_details: null }));
    const final = delta({ output_tokens: 9 }); session.push(final); expect(session.push(final)).toEqual([]);
    expect(session.push({ type: 'message_stop' })).toEqual([]);
    expect(session.push(final)).toEqual([]);
    const first = session.finish(complete); expect(session.finish(cancelled)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true); expect(session.push(start(usage))).toEqual([]);
  });
});
