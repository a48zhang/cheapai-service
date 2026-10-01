import type { StreamUsageSession, UsageExtractor } from '../types/adapter.js';
import type { JsonObject, JsonValue, TokenCounts, UsageSemantics, UsageSnapshot, UsageSource, UsageUpdate } from '../types/shared.js';

const semantics: UsageSemantics = Object.freeze({
  cacheRead: 'included_in_input', cacheWrite: 'included_in_input',
  reasoning: 'included_in_output', cacheWriteTtl: 'unknown',
});
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const validCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
type MutableCounts = { -readonly [K in keyof TokenCounts]: TokenCounts[K] };

/** Copy only the usage subtree; limit depth, visits and UTF-8 bytes before retaining it. */
function boundedRaw(value: unknown): JsonObject | undefined {
  let remaining = 4096;
  let visits = 128;
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  const visit = (v: unknown, depth: number): JsonValue => {
    if (--visits < 0 || depth > 8) throw new Error('limit');
    if (typeof v === 'string') {
      if (v.length > remaining) throw new Error('limit');
      remaining -= encoder.encode(JSON.stringify(v)).byteLength;
    } else if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) {
      remaining -= String(v).length;
    } else if (Array.isArray(v) || record(v)) {
      if (ancestors.has(v)) throw new Error('cycle');
      ancestors.add(v); remaining -= 2;
      let result: JsonValue;
      if (Array.isArray(v)) result = Object.freeze(Array.from(v, x => { remaining--; return visit(x, depth + 1); }));
      else {
        const copy: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
        for (const [key, item] of Object.entries(v)) {
          visit(key, depth + 1); remaining -= 2;
          copy[key] = visit(item, depth + 1);
        }
        result = Object.freeze(copy);
      }
      ancestors.delete(v);
      if (remaining < 0) throw new Error('limit');
      return result;
    } else throw new Error('non_json');
    if (remaining < 0) throw new Error('limit');
    return v as JsonValue;
  };
  try { const raw = visit(value, 0); return record(raw) ? raw as JsonObject : undefined; } catch { return undefined; }
}

function contradictions(counts: TokenCounts): string[] {
  const issues: string[] = [];
  const { inputTokens: input, outputTokens: output, totalTokens: total, cacheReadTokens: cached, cacheWriteTokens: written, reasoningTokens: reasoning } = counts;
  if (input !== undefined && output !== undefined) {
    const sum = input + output;
    if (!Number.isSafeInteger(sum)) issues.push('unsafe_combined_total');
    else if (total !== undefined && total !== sum) issues.push('total_tokens_mismatch');
  }
  if (total !== undefined && ((input !== undefined && total < input) || (output !== undefined && total < output))) issues.push('total_tokens_below_component');
  if (input !== undefined && cached !== undefined && cached > input) issues.push('cached_tokens_exceed_input');
  if (input !== undefined && written !== undefined && written > input) issues.push('cache_write_tokens_exceed_input');
  if (input !== undefined && cached !== undefined && written !== undefined && cached + written > input) issues.push('cache_components_exceed_input');
  if (output !== undefined && reasoning !== undefined && reasoning > output) issues.push('reasoning_tokens_exceed_output');
  return issues;
}

function inspectUsage(usage: unknown, path: string, eventType?: string) {
  const counts: MutableCounts = {};
  const issues: string[] = [];
  const raw = boundedRaw(usage);
  const source: UsageSource = Object.freeze({ protocol: 'chat', path, ...(eventType === undefined ? {} : { eventType }), ...(raw === undefined ? {} : { raw }) });
  if (!record(usage)) return { counts, issues: ['invalid_usage_object'], source };
  const read = (container: Record<string, unknown>, field: string, target: keyof TokenCounts, prefix = '') => {
    if (!(field in container)) return;
    const count = container[field];
    if (!validCount(count)) issues.push(`invalid_${prefix}${field}`);
    else counts[target] = count;
  };
  read(usage, 'prompt_tokens', 'inputTokens');
  read(usage, 'completion_tokens', 'outputTokens');
  read(usage, 'total_tokens', 'totalTokens');
  for (const field of ['prompt_tokens_details', 'completion_tokens_details'] as const) {
    if (!(field in usage)) continue;
    const details = usage[field];
    if (!record(details)) { issues.push(`invalid_${field}`); continue; }
    if (field === 'prompt_tokens_details') {
      read(details, 'cached_tokens', 'cacheReadTokens');
      read(details, 'cache_write_tokens', 'cacheWriteTokens');
    } else read(details, 'reasoning_tokens', 'reasoningTokens');
  }
  issues.push(...contradictions(counts));
  // Raw retention failure does not turn otherwise valid counters into bad usage.
  return { counts, issues, source };
}

function snapshot(counts: TokenCounts, sources: readonly UsageSource[], issues: readonly string[], final: boolean): UsageSnapshot {
  if (!sources.length) return Object.freeze({ quality: 'missing', protocol: 'chat' });
  const problems = [...new Set(issues)];
  if (!final) problems.push('missing_final_usage');
  if (counts.inputTokens === undefined) problems.push('missing_prompt_tokens');
  if (counts.outputTokens === undefined) problems.push('missing_completion_tokens');
  const common = { protocol: 'chat' as const, semantics, sources: Object.freeze([...sources]), issues: Object.freeze(problems) };
  if (issues.length) return Object.freeze({ ...common, quality: 'invalid', counts: Object.freeze({ ...counts }) });
  if (counts.inputTokens !== undefined && counts.outputTokens !== undefined && final) {
    return Object.freeze({ ...common, quality: 'complete', counts: Object.freeze({ ...counts, inputTokens: counts.inputTokens, outputTokens: counts.outputTokens }) });
  }
  return Object.freeze({ ...common, quality: 'partial', counts: Object.freeze({ ...counts }) });
}

/** Read the provider's original JSON body; choices/text never contribute tokens. */
export function extractChatUsage(input: unknown): UsageSnapshot {
  if (!record(input) || input.usage === undefined || input.usage === null) return snapshot({}, [], [], false);
  const read = inspectUsage(input.usage, 'usage');
  return snapshot(read.counts, [read.source], read.issues, true);
}

/**
 * Native Chat chunks contain cumulative usage. A choice finish_reason ends that
 * choice, not accounting: include_usage may deliver a later choices:[] chunk.
 * A complete usage-only chunk is final accounting evidence even if [DONE] is
 * subsequently lost. Transport completion alone cannot bless early totals.
 */
export function createChatUsageSession(): StreamUsageSession<unknown> {
  let counts: MutableCounts = {};
  const issues = new Set<string>();
  const sources = new Map<'chunk' | 'usage_chunk', UsageSource>();
  let sequence = 0;
  let lastFingerprint: string | undefined;
  let done = false;
  let finalUsage = false;
  let finished: UsageSnapshot | undefined;
  const seal = (): readonly UsageUpdate[] => {
    done = true;
    return [];
  };
  return {
    push(input): readonly UsageUpdate[] {
      if (finished || done) return [];
      let chunk = input;
      if (chunk === '[DONE]') return seal();
      if (record(chunk) && typeof chunk.data === 'string' && !('object' in chunk)) {
        if (chunk.data.trim() === '[DONE]') return seal();
        try { chunk = JSON.parse(chunk.data) as unknown; } catch { return []; }
      }
      if (!record(chunk) || chunk.object !== 'chat.completion.chunk' || !Array.isArray(chunk.choices)) return [];
      if (chunk.usage === undefined || chunk.usage === null) return [];
      const read = inspectUsage(chunk.usage, 'usage', 'chat.completion.chunk');
      const location = chunk.choices.length === 0 ? 'usage_chunk' : 'chunk';
      const fingerprint = JSON.stringify([location, read.counts, read.issues]);
      if (fingerprint === lastFingerprint) return [];
      lastFingerprint = fingerprint;
      sources.set(location, read.source); // Only two locations; never retain choices/deltas.
      for (const issue of read.issues) issues.add(issue);
      for (const key of Object.keys(read.counts) as (keyof TokenCounts)[]) {
        const next = read.counts[key];
        if (next !== undefined && counts[key] !== undefined && next < counts[key]) issues.add(`regressed_${key}`);
      }
      counts = { ...counts, ...read.counts };
      for (const issue of contradictions(counts)) issues.add(issue);
      // An empty/partial later usage object must not bless earlier stale totals.
      finalUsage = location === 'usage_chunk' && read.counts.inputTokens !== undefined && read.counts.outputTokens !== undefined;
      return [Object.freeze({ sequence: ++sequence, mode: 'cumulative', counts: Object.freeze({ ...read.counts }), semantics, source: read.source, final: finalUsage })];
    },
    finish() {
      finished ??= snapshot(counts, [...sources.values()], [...issues], finalUsage);
      return finished;
    },
  };
}

export const chatUsageExtractor: UsageExtractor<unknown, unknown, 'chat'> = Object.freeze({
  protocol: 'chat', json: extractChatUsage, createStream: createChatUsageSession,
});
