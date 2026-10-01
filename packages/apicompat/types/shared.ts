/** Shared semantics, not a canonical wire protocol. No runtime dependencies. */
export type Protocol = "chat" | "responses" | "messages";

/** Request: downstream -> upstream. Response/stream: upstream -> downstream. */
export interface ConversionDirection<From extends Protocol = Protocol, To extends Protocol = Protocol> {
  readonly from: From;
  readonly to: To;
}

export type JsonValue = null | boolean | number | string | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Safe, public error details only: never raw provider bodies, headers or secrets. */
export interface ProtocolError {
  readonly kind: "invalid_request" | "unsupported_feature" | "upstream_error" | "invalid_response" | "stream_error";
  readonly code: string;
  readonly message: string;
  /** Field path in the input protocol when known. */
  readonly param?: string;
  readonly upstreamStatus?: number;
}

export type ConversionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProtocolError };

/** Unknown reasons must remain explicit; they must not become normal completion. */
export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | "refusal" | "unknown";

export type TerminalState =
  | { readonly status: "completed"; readonly reason: "stop" | "tool_calls"; readonly upstreamReason?: string }
  | { readonly status: "incomplete"; readonly reason: "length" | "content_filter" | "refusal" | "unknown" | "unexpected_eof"; readonly upstreamReason?: string }
  | { readonly status: "failed"; readonly error: ProtocolError }
  | { readonly status: "cancelled" };

/** Kept stable throughout a response; upstream and downstream IDs may differ. */
export interface ResponseIdentity {
  readonly responseId: string;
  readonly upstreamResponseId?: string;
}

/** Zero is a valid index. Tool arguments are fragments, not necessarily JSON. */
export interface ContentIdentity {
  readonly outputIndex: number;
  readonly contentIndex?: number;
  readonly itemId?: string;
  readonly toolCallId?: string;
}

export type UsageQuality = "complete" | "partial" | "missing" | "invalid";

/**
 * Provider counts before billing normalization. Missing fields are unknown, not
 * zero. Values must be nonnegative safe integers, checked by the extractor.
 * Cache/reasoning counts are not extra billable buckets by themselves.
 */
export interface TokenCounts {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheWrite5mTokens?: number;
  readonly cacheWrite1hTokens?: number;
  readonly reasoningTokens?: number;
}

/** Inclusion is explicit because providers use different input/output totals. */
export interface UsageSemantics {
  readonly cacheRead: "included_in_input" | "excluded_from_input" | "unknown";
  readonly cacheWrite: "included_in_input" | "excluded_from_input" | "unknown";
  readonly reasoning: "included_in_output" | "excluded_from_output" | "unknown";
  /** When present, TTL fields are subsets of cacheWriteTokens, not additions. */
  readonly cacheWriteTtl: "subsets_of_cache_write" | "unknown";
}

export interface UsageSource {
  readonly protocol: Protocol;
  /** Location of the original usage, e.g. message_start.message.usage. */
  readonly path: string;
  readonly eventType?: string;
  /** Usage object only, never the containing prompt/response or credentials. */
  readonly raw?: JsonObject;
}

/**
 * One observed upstream update. Cumulative replaces known fields; delta adds
 * known fields. Omitted fields never reset totals. Sequence is local and strictly
 * increasing within this response, so an accumulator can reject replay.
 */
export interface UsageUpdate {
  readonly sequence: number;
  readonly mode: "cumulative" | "delta";
  readonly counts: TokenCounts;
  readonly semantics: UsageSemantics;
  readonly source: UsageSource;
  readonly final: boolean;
}

/** Always accumulated upstream evidence; never measured from converted output. */
export type UsageSnapshot =
  | { readonly quality: "missing"; readonly protocol: Protocol }
  | ((
      | { readonly quality: "complete"; readonly counts: TokenCounts & { readonly inputTokens: number; readonly outputTokens: number } }
      | { readonly quality: "partial" | "invalid"; readonly counts: TokenCounts }
    ) & {
      readonly protocol: Protocol;
      readonly semantics: UsageSemantics;
      /** Bounded evidence by usage location, not an unbounded event history. */
      readonly sources: readonly UsageSource[];
      /** Safe diagnostic codes explaining partial/invalid evidence. */
      readonly issues: readonly string[];
    });

/** Parsed SSE frame, after UTF-8 decoding and multiline data joining. */
export interface SseFrame {
  readonly data: string;
  readonly event?: string;
  readonly id?: string;
  readonly retry?: number;
}
