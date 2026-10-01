import type {
  ConversionDirection,
  ConversionResult,
  Protocol,
  ProtocolError,
  ResponseIdentity,
  SseFrame,
  TerminalState,
  UsageSnapshot,
  UsageUpdate,
} from "./shared.js";

/** Values supplied by the caller; adapters neither route nor fetch a model. */
export interface RequestContext {
  readonly targetModel: string;
}

export interface ResponseContext {
  readonly identity: ResponseIdentity;
  readonly targetModel: string;
  /** Unix seconds, fixed for this response; no clock access inside adapters. */
  readonly createdAt: number;
  /**
   * Pure per-response ID allocator. Same kind/key must return the same ID;
   * distinct keys must not collide. Original tool-call IDs are preserved when
   * representable. The implementation must not fetch or access external state.
   */
  readonly idFor: (kind: "item" | "tool_call", key: string) => string;
}

/** Direct wire request conversion; rejects constraints it cannot represent. */
export interface RequestAdapter<Input, Output, From extends Protocol = Protocol, To extends Protocol = Protocol>
  extends ConversionDirection<From, To> {
  readonly convert: (input: Input, context: RequestContext) => ConversionResult<Output>;
}

export interface JsonResponseOutput<Body> {
  readonly body: Body;
  readonly identity: ResponseIdentity;
  readonly terminal: TerminalState;
}

/** Does not extract billable usage; wire usage mapping is presentation only. */
export interface JsonResponseAdapter<Input, Output, From extends Protocol = Protocol, To extends Protocol = Protocol>
  extends ConversionDirection<From, To> {
  readonly convert: (input: Input, context: ResponseContext) => ConversionResult<JsonResponseOutput<Output>>;
}

/** HTTP status selection/headers remain in the gateway, outside this contract. */
export interface ErrorAdapter<Output, To extends Protocol = Protocol> {
  readonly to: To;
  readonly convert: (error: ProtocolError) => Output;
}

export interface StreamOptions {
  readonly unknownEventPolicy: "ignore" | "reject" | "preserve";
  /** Maximum retained state bytes; enforce before growing fragment buffers. */
  readonly maxBufferedBytes: number;
}

/** Transport end is distinct from a provider's valid terminal event. */
export type StreamEnd =
  | { readonly kind: "eof" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error"; readonly error: ProtocolError };

export interface StreamStep<OutputEvent> {
  /** Ordered native target events; a call may emit none or multiple events. */
  readonly events: readonly OutputEvent[];
  /** Emitted once only, with the last terminal wire event(s), if any. */
  readonly terminal?: TerminalState;
}

/**
 * One instance per response. push consumes one decoded source event, never a
 * network chunk. It handles native item/block/tool lifecycles directly; it does
 * not require a canonical wire intermediary. Native finish markers may precede
 * final usage, so the adapter decides when the whole stream is terminal.
 *
 * Conversion faults become failed StreamSteps, not uncaught transport errors.
 * finish(eof) without a native terminal is incomplete, never fabricated success.
 * finish(cancelled) emits no further wire events. Once terminal, push/finish
 * return empty events without repeating the terminal. All retained state is
 * bounded by maxBufferedBytes. The caller owns backpressure and cancellation I/O.
 */
export interface StreamSession<InputEvent, OutputEvent> {
  readonly push: (event: InputEvent) => StreamStep<OutputEvent>;
  readonly finish: (end: StreamEnd) => StreamStep<OutputEvent>;
}

export interface StreamAdapter<InputEvent = SseFrame, OutputEvent = SseFrame, From extends Protocol = Protocol, To extends Protocol = Protocol>
  extends ConversionDirection<From, To> {
  /** preserve is valid only for allowed, equivalent extensions; otherwise fail. */
  readonly create: (context: ResponseContext, options: StreamOptions) => ConversionResult<StreamSession<InputEvent, OutputEvent>>;
}

/** Stateful usage extraction is separate from response/event presentation. */
export interface StreamUsageSession<InputEvent> {
  /** Consume each original upstream event once; may contain multiple updates. */
  readonly push: (event: InputEvent) => readonly UsageUpdate[];
  /** Idempotent final snapshot. Missing/partial evidence must not become zero. */
  readonly finish: (terminal: TerminalState) => UsageSnapshot;
}

/** No prices, charges, persistence or access to converted downstream events. */
export interface UsageExtractor<JsonInput, StreamInput = SseFrame, Source extends Protocol = Protocol> {
  readonly protocol: Source;
  readonly json: (input: JsonInput) => UsageSnapshot;
  readonly createStream: () => StreamUsageSession<StreamInput>;
}
