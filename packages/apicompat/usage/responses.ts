import type { StreamUsageSession, UsageExtractor } from '../types/adapter.js';
import type { JsonObject, JsonValue, TokenCounts, UsageSemantics, UsageSnapshot, UsageSource, UsageUpdate } from '../types/shared.js';

const semantics: UsageSemantics = Object.freeze({
  cacheRead: 'included_in_input', cacheWrite: 'included_in_input',
  reasoning: 'included_in_output', cacheWriteTtl: 'unknown',
});
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const validCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
type MutableCounts = { -readonly [K in keyof TokenCounts]: TokenCounts[K] };
const nativeEvents = new Set(['response.created', 'response.queued', 'response.in_progress', 'response.completed', 'response.failed', 'response.incomplete']);
const finalEvents = new Set(['response.completed', 'response.failed', 'response.incomplete']);

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
  const source: UsageSource = Object.freeze({ protocol: 'responses', path, ...(eventType === undefined ? {} : { eventType }), ...(raw === undefined ? {} : { raw }) });
  if (!record(usage)) return { counts, issues: ['invalid_usage_object'], source };
  const read = (container: Record<string, unknown>, field: string, target: keyof TokenCounts, prefix = '') => {
    if (!(field in container)) return;
    const count = container[field];
    if (!validCount(count)) issues.push(`invalid_${prefix}${field}`);
    else counts[target] = count;
  };
  read(usage, 'input_tokens', 'inputTokens');
  read(usage, 'output_tokens', 'outputTokens');
  read(usage, 'total_tokens', 'totalTokens');
  for (const field of ['input_tokens_details', 'output_tokens_details'] as const) {
    if (!(field in usage)) continue;
    const details = usage[field];
    if (!record(details)) { issues.push(`invalid_${field}`); continue; }
    if (field === 'input_tokens_details') {
      read(details, 'cached_tokens', 'cacheReadTokens');
      read(details, 'cache_write_tokens', 'cacheWriteTokens');
    } else read(details, 'reasoning_tokens', 'reasoningTokens');
  }
  issues.push(...contradictions(counts));
  // Raw retention failure does not turn otherwise valid counters into bad usage.
  return { counts, issues, source };
}

function snapshot(counts: TokenCounts, sources: readonly UsageSource[], issues: readonly string[], final: boolean): UsageSnapshot {
  if (!sources.length) return Object.freeze({ quality: 'missing', protocol: 'responses' });
  const problems = [...new Set(issues)];
  if (!final) problems.push('missing_final_usage');
  if (counts.inputTokens === undefined) problems.push('missing_input_tokens');
  if (counts.outputTokens === undefined) problems.push('missing_output_tokens');
  const common = { protocol: 'responses' as const, semantics, sources: Object.freeze([...sources]), issues: Object.freeze(problems) };
  if (issues.length) return Object.freeze({ ...common, quality: 'invalid', counts: Object.freeze({ ...counts }) });
  if (counts.inputTokens !== undefined && counts.outputTokens !== undefined && final) {
    return Object.freeze({ ...common, quality: 'complete', counts: Object.freeze({ ...counts, inputTokens: counts.inputTokens, outputTokens: counts.outputTokens }) });
  }
  return Object.freeze({ ...common, quality: 'partial', counts: Object.freeze({ ...counts }) });
}

/** Input is the original provider response body, not its converted presentation. */
export function extractResponsesUsage(input: unknown): UsageSnapshot {
  if (!record(input) || input.usage === undefined || input.usage === null) return snapshot({}, [], [], false);
  const read = inspectUsage(input.usage, 'usage');
  const final = input.status !== 'queued' && input.status !== 'in_progress';
  return snapshot(read.counts, [read.source], read.issues, final);
}

/** Accepts decoded native events or parser-produced SSE frames. Never estimates from deltas. */
export function createResponsesUsageSession(): StreamUsageSession<unknown> {
  let counts: MutableCounts = {};
  const sources = new Map<string, UsageSource>();
  const issues = new Set<string>();
  let sequence = 0;
  let lastProviderSequence = -1;
  let lastFingerprint: string | undefined;
  let nativeFinal = false;
  let finalUsage = false;
  let finished: UsageSnapshot | undefined;
  return {
    push(input): readonly UsageUpdate[] {
      if (finished || nativeFinal) return [];
      let event = input;
      if (record(event) && typeof event.data === 'string' && !('type' in event)) {
        if (event.data === '[DONE]') return [];
        try { event = JSON.parse(event.data) as unknown; } catch { return []; }
      }
      if (!record(event) || typeof event.type !== 'string' || !nativeEvents.has(event.type)) return [];
      if ('sequence_number' in event) {
        if (!validCount(event.sequence_number)) { issues.add('invalid_event_sequence'); return []; }
        if (event.sequence_number <= lastProviderSequence) return [];
        lastProviderSequence = event.sequence_number;
      }
      const final = finalEvents.has(event.type);
      nativeFinal = final;
      if (!record(event.response) || event.response.usage === undefined || event.response.usage === null) return [];
      const read = inspectUsage(event.response.usage, 'response.usage', event.type);
      const fingerprint = JSON.stringify([event.type, read.counts, read.issues]);
      if (fingerprint === lastFingerprint && !final) return [];
      lastFingerprint = fingerprint;
      sources.set(event.type, read.source); // Fixed six locations; no retained event history.
      for (const issue of read.issues) issues.add(issue);
      for (const key of Object.keys(read.counts) as (keyof TokenCounts)[]) {
        const next = read.counts[key];
        if (next !== undefined && counts[key] !== undefined && next < counts[key]) issues.add(`regressed_${key}`);
      }
      counts = { ...counts, ...read.counts };
      for (const issue of contradictions(counts)) issues.add(issue);
      // Earlier totals can be stale: retain them as evidence but do not claim
      // completeness when the terminal usage omits either authoritative total.
      finalUsage = final && read.counts.inputTokens !== undefined && read.counts.outputTokens !== undefined;
      const update: UsageUpdate = Object.freeze({
        sequence: ++sequence, mode: 'cumulative', counts: Object.freeze({ ...read.counts }),
        semantics, source: read.source, final,
      });
      return [update];
    },
    finish() {
      finished ??= snapshot(counts, [...sources.values()], [...issues], finalUsage);
      return finished;
    },
  };
}

export const responsesUsageExtractor: UsageExtractor<unknown, unknown, 'responses'> = Object.freeze({
  protocol: 'responses', json: extractResponsesUsage, createStream: createResponsesUsageSession,
});
