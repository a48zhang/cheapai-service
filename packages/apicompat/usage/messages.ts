import type { StreamUsageSession, UsageExtractor } from '../types/adapter.js';
import type { JsonObject, JsonValue, TokenCounts, UsageSemantics, UsageSnapshot, UsageSource, UsageUpdate } from '../types/shared.js';

const semantics: UsageSemantics = Object.freeze({
  cacheRead: 'excluded_from_input', cacheWrite: 'excluded_from_input',
  reasoning: 'included_in_output', cacheWriteTtl: 'subsets_of_cache_write',
});
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
type MutableCounts = { -readonly [K in keyof TokenCounts]: TokenCounts[K] };

function contradictions(value: TokenCounts): string[] {
  const errors: string[] = [];
  const { cacheWriteTokens: writes, cacheWrite5mTokens: short, cacheWrite1hTokens: long, outputTokens: output, reasoningTokens: thinking } = value;
  if (output !== undefined && thinking !== undefined && thinking > output) errors.push('thinking_tokens_exceed_output');
  if (writes !== undefined) {
    if ((short !== undefined && short > writes) || (long !== undefined && long > writes)) errors.push('cache_ttl_exceeds_aggregate');
    if (short !== undefined && long !== undefined && short + long !== writes) errors.push('cache_ttl_aggregate_mismatch');
  }
  if (short !== undefined && long !== undefined && !Number.isSafeInteger(short + long)) errors.push('unsafe_cache_ttl_sum');
  // Cache counts are additional input buckets, not subsets of input_tokens.
  const aggregate = [value.inputTokens, value.outputTokens, value.cacheReadTokens, value.cacheWriteTokens];
  if (aggregate.every((v): v is number => v !== undefined) && !Number.isSafeInteger(aggregate.reduce((a, b) => a + b, 0))) errors.push('unsafe_combined_total');
  return errors;
}

/**
 * Redacted evidence contains recognized token leaves and two server-tool count
 * leaves, never raw
 * prompts, headers, provider metadata or arbitrary extension values. Even bad
 * count strings are omitted so diagnostics cannot echo secrets. This fixed
 * allowlist bounds each source independently of provider body size/depth.
 */
function inspectUsage(value: unknown, path: string, eventType?: string) {
  const counts: MutableCounts = {};
  const issues: string[] = [];
  const raw: Record<string, JsonValue> = {};
  const field = (input: Record<string, unknown>, key: string, target: keyof TokenCounts, evidence: Record<string, JsonValue>) => {
    if (!Object.hasOwn(input, key)) return;
    const v = input[key];
    if (v === null || (typeof v === 'number' && Number.isFinite(v))) evidence[key] = v;
    // Nullable optional fields mean unavailable rather than a fabricated zero.
    if (v === null || v === undefined) return;
    if (!count(v)) issues.push(`invalid_${key}`);
    else counts[target] = v;
  };
  if (!object(value)) issues.push('invalid_usage_object');
  else {
    field(value, 'input_tokens', 'inputTokens', raw);
    field(value, 'output_tokens', 'outputTokens', raw);
    field(value, 'cache_read_input_tokens', 'cacheReadTokens', raw);
    field(value, 'cache_creation_input_tokens', 'cacheWriteTokens', raw);
    // Standard producer metadata is not a token count or an instruction to alter
    // configured selling prices. Keep arbitrary metadata strings out of evidence.
    if (Object.hasOwn(value, 'service_tier') && value.service_tier !== null && value.service_tier !== undefined
      && (typeof value.service_tier !== 'string' || !['standard', 'priority', 'batch'].includes(value.service_tier))) issues.push('invalid_service_tier');
    if (Object.hasOwn(value, 'inference_geo') && value.inference_geo !== null && value.inference_geo !== undefined
      && (typeof value.inference_geo !== 'string' || value.inference_geo.length > 64 || value.inference_geo.trim() !== value.inference_geo
        || /[\u0000-\u001f\u007f]/.test(value.inference_geo))) issues.push('invalid_inference_geo');
    // P04/P17 may preserve these standard wire counters, but phase-one pricing
    // has no server-tool tariff. Never silently ignore nonzero/unknown tool work
    // and then declare the remaining token evidence complete and priceable.
    if (Object.hasOwn(value, 'server_tool_use')) {
      const server = value.server_tool_use;
      if (server === null) raw.server_tool_use = null; // Explicit optional absence, not synthesized zero leaves.
      else if (!object(server)) issues.push('invalid_server_tool_usage');
      else {
        const leaves = ['web_fetch_requests', 'web_search_requests'] as const;
        const observed: Record<string, JsonValue> = {};
        if (Object.keys(server).some(key => !leaves.includes(key as typeof leaves[number]))) issues.push('unknown_server_tool_usage');
        for (const leaf of leaves) {
          const measured = server[leaf];
          if (measured === null || (typeof measured === 'number' && Number.isFinite(measured))) observed[leaf] = measured;
          if (!Object.hasOwn(server, leaf) || measured === null || measured === undefined) issues.push('unknown_server_tool_usage');
          else if (!count(measured)) issues.push('invalid_server_tool_usage');
          else if (measured > 0) issues.push('unsupported_server_tool_usage');
        }
        raw.server_tool_use = Object.freeze(observed);
      }
    }
    for (const name of ['cache_creation', 'output_tokens_details'] as const) {
      if (!Object.hasOwn(value, name) || value[name] === null || value[name] === undefined) continue;
      const details = value[name];
      if (!object(details)) { issues.push(`invalid_${name}`); continue; }
      const sub: Record<string, JsonValue> = {};
      if (name === 'cache_creation') {
        field(details, 'ephemeral_5m_input_tokens', 'cacheWrite5mTokens', sub);
        field(details, 'ephemeral_1h_input_tokens', 'cacheWrite1hTokens', sub);
      } else field(details, 'thinking_tokens', 'reasoningTokens', sub);
      raw[name] = Object.freeze(sub);
    }
    issues.push(...contradictions(counts));
  }
  const source: UsageSource = Object.freeze({ protocol: 'messages', path, ...(eventType === undefined ? {} : { eventType }), ...(object(value) ? { raw: Object.freeze(raw) as JsonObject } : {}) });
  return { counts, issues, source };
}

function snapshot(counts: TokenCounts, sources: readonly UsageSource[], invalid: readonly string[], final: boolean): UsageSnapshot {
  if (!sources.length) return Object.freeze({ quality: 'missing', protocol: 'messages' });
  const issues = [...new Set(invalid)];
  const required = [
    ['inputTokens', 'missing_input_tokens'], ['outputTokens', 'missing_output_tokens'],
    ['cacheReadTokens', 'missing_cache_read_input_tokens'], ['cacheWriteTokens', 'missing_cache_creation_input_tokens'],
  ] as const;
  for (const [field, issue] of required) if (counts[field] === undefined) issues.push(issue);
  if (!final) issues.push('missing_final_usage');
  const common = { protocol: 'messages' as const, semantics, sources: Object.freeze([...sources]), issues: Object.freeze(issues) };
  if (invalid.length) return Object.freeze({ ...common, quality: 'invalid', counts: Object.freeze({ ...counts }) });
  if (issues.length === 0 && counts.inputTokens !== undefined && counts.outputTokens !== undefined) {
    return Object.freeze({ ...common, quality: 'complete', counts: Object.freeze({ ...counts, inputTokens: counts.inputTokens, outputTokens: counts.outputTokens }) });
  }
  return Object.freeze({ ...common, quality: 'partial', counts: Object.freeze({ ...counts }) });
}

export function extractMessagesUsage(input: unknown): UsageSnapshot {
  if (!object(input) || input.usage === undefined || input.usage === null) return snapshot({}, [], [], false);
  const inspected = inspectUsage(input.usage, 'usage');
  return snapshot(inspected.counts, [inspected.source], inspected.issues, input.stop_reason !== null);
}

/** Native message_delta usage is cumulative, despite the event's name. */
export function createMessagesUsageSession(): StreamUsageSession<unknown> {
  let counts: MutableCounts = {};
  const sources = new Map<'message_start' | 'message_delta', UsageSource>();
  const issues = new Set<string>();
  let localSequence = 0;
  let lastFingerprint: string | undefined;
  let outputObservedInDelta = false;
  let finalUsage = false;
  let sealed = false;
  let finished: UsageSnapshot | undefined;
  return {
    push(input): readonly UsageUpdate[] {
      if (finished || sealed) return [];
      let event = input;
      if (object(event) && typeof event.data === 'string' && !('type' in event)) {
        try { event = JSON.parse(event.data) as unknown; } catch { return []; }
      }
      if (!object(event)) return [];
      if (event.type === 'message_stop') {
        sealed = true;
        // Message stop cannot manufacture a missing output observation.
        if (!finalUsage && outputObservedInDelta) {
          finalUsage = true;
          const source = sources.get('message_delta');
          if (source) return [Object.freeze({ sequence: ++localSequence, mode: 'cumulative', counts: Object.freeze({ ...counts }), semantics, source, final: true })];
        }
        return [];
      }
      if (event.type !== 'message_start' && event.type !== 'message_delta') return [];
      const isStart = event.type === 'message_start';
      const value = isStart ? (object(event.message) ? event.message.usage : undefined) : event.usage;
      if (value === undefined || value === null) return [];
      const inspected = inspectUsage(value, isStart ? 'message.usage' : 'usage', event.type);
      const final = !isStart && object(event.delta) && typeof event.delta.stop_reason === 'string' && event.delta.stop_reason.length > 0;
      const fingerprint = JSON.stringify([event.type, inspected.counts, inspected.issues, final]);
      if (fingerprint === lastFingerprint) return [];
      lastFingerprint = fingerprint;
      if (isStart && sources.has('message_delta')) issues.add('late_message_start_usage');
      sources.set(event.type, inspected.source);
      for (const issue of inspected.issues) issues.add(issue);
      for (const field of Object.keys(inspected.counts) as (keyof TokenCounts)[]) {
        const next = inspected.counts[field];
        if (next !== undefined && counts[field] !== undefined && next < counts[field]) issues.add(`regressed_${field}`);
      }
      counts = { ...counts, ...inspected.counts };
      for (const issue of contradictions(counts)) issues.add(issue);
      if (!isStart) {
        outputObservedInDelta = inspected.counts.outputTokens !== undefined;
        finalUsage = final && outputObservedInDelta;
      }
      return [Object.freeze({ sequence: ++localSequence, mode: 'cumulative', counts: Object.freeze({ ...inspected.counts }), semantics, source: inspected.source, final: finalUsage })];
    },
    finish() {
      finished ??= snapshot(counts, [...sources.values()], [...issues], finalUsage);
      return finished;
    },
  };
}

export const messagesUsageExtractor: UsageExtractor<unknown, unknown, 'messages'> = Object.freeze({
  protocol: 'messages', json: extractMessagesUsage, createStream: createMessagesUsageSession,
});
