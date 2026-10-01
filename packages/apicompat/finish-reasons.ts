import type { ConversionResult, FinishReason, Protocol, ProtocolError, TerminalState } from './types/shared.js';

export interface NativeFinishInput {
  readonly from: Protocol;
  /** Chat finish_reason, Messages stop_reason, or Responses status. */
  readonly rawReason: string | null;
  /** Responses incomplete_details.reason; never inferred from HTTP status. */
  readonly incompleteReason?: string | null;
  /** Native output evidence, especially required for Responses completed. */
  readonly hasToolCalls?: boolean;
  readonly hasRefusal?: boolean;
  /** Call on a terminal observation, not each null chunk; eof means no native terminal was accepted. */
  readonly event?: 'native' | 'eof' | 'cancelled' | 'failed';
  /** Already sanitized by the error boundary; do not pass raw provider bodies. */
  readonly error?: ProtocolError;
}

export interface NormalizedFinish {
  readonly from: Protocol;
  readonly rawReason: string | null;
  readonly incompleteReason: string | null;
  readonly terminal: TerminalState;
  /** Failure/cancellation/EOF have no equivalent shared FinishReason. */
  readonly finishReason: FinishReason | null;
}

type NativeTarget =
  | { readonly to: 'chat'; readonly finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' }
  | { readonly to: 'messages'; readonly stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'model_context_window_exceeded' | 'refusal' }
  | { readonly to: 'responses'; readonly status: 'completed'; readonly incomplete_details: null }
  | { readonly to: 'responses'; readonly status: 'incomplete'; readonly incomplete_details: { readonly reason: 'max_output_tokens' | 'content_filter' } };

/** Termination instructions only: no text, usage, billing, HTTP or SSE framing. */
export type TargetFinish =
  | (NativeTarget & { readonly kind: 'native'; readonly source: NormalizedFinish })
  | ({ readonly kind: 'refusal'; readonly source: NormalizedFinish; readonly requiresRefusalPayload: true;
       readonly refusalPayload: { readonly refusal: string } } & (
      | { readonly to: 'chat'; readonly finish_reason: 'stop'; readonly refusalField: 'message.refusal' }
      | { readonly to: 'responses'; readonly status: 'completed'; readonly refusalField: 'output[].content[].refusal' }
    ))
  | { readonly kind: 'error'; readonly to: Protocol; readonly source: NormalizedFinish; readonly error: ProtocolError }
  | { readonly kind: 'cancelled'; readonly to: Protocol; readonly source: NormalizedFinish };

export interface TargetFinishOptions {
  /** Actual validated native refusal, never synthesized from an error/reason. */
  readonly refusalPayload?: { readonly refusal: string };
}

const safeError = (kind: ProtocolError['kind'], code: string): ProtocolError => ({
  kind, code, message: 'The response did not reach a representable successful completion.',
});
const validReason = (value: string | null | undefined): boolean => value == null
  || (typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_.:-]/u.test(value));

/** Unknown/native pause reasons are incomplete, never normal end-of-turn. */
export function normalizeFinish(input: NativeFinishInput): ConversionResult<NormalizedFinish> {
  if (!validReason(input.rawReason) || !validReason(input.incompleteReason)) return {
    ok: false, error: { ...safeError('invalid_response', 'invalid_finish_reason'), param: 'finish_reason' },
  };
  const completed = (reason: 'stop' | 'tool_calls'): TerminalState => ({ status: 'completed', reason, upstreamReason: input.rawReason ?? 'missing' });
  const incomplete = (reason: Extract<TerminalState, { status: 'incomplete' }>['reason']): TerminalState => ({
    status: 'incomplete', reason, ...(input.rawReason === null ? {} : { upstreamReason: input.incompleteReason ?? input.rawReason }),
  });
  let terminal: TerminalState;
  if (input.event === 'cancelled') terminal = { status: 'cancelled' };
  else if (input.event === 'failed') terminal = { status: 'failed', error: input.error ?? safeError('upstream_error', 'upstream_failed') };
  else if (input.event === 'eof') terminal = incomplete('unexpected_eof');
  else if (input.rawReason === null) return { ok: false, error: safeError('invalid_response', 'missing_finish_reason') };
  else {
    switch (input.from) {
      case 'chat':
        switch (input.rawReason) {
          case 'stop': terminal = input.hasRefusal ? incomplete('refusal') : completed('stop'); break;
          case 'tool_calls': case 'function_call': terminal = completed('tool_calls'); break;
          case 'length': terminal = incomplete('length'); break;
          case 'content_filter': terminal = incomplete('content_filter'); break;
          case 'refusal': terminal = incomplete('refusal'); break;
          default: terminal = incomplete('unknown');
        }
        break;
      case 'messages':
        switch (input.rawReason) {
          case 'end_turn': case 'stop_sequence': terminal = input.hasRefusal ? incomplete('refusal') : completed('stop'); break;
          case 'tool_use': terminal = completed('tool_calls'); break;
          case 'max_tokens': case 'model_context_window_exceeded': terminal = incomplete('length'); break;
          case 'refusal': terminal = incomplete('refusal'); break;
          // pause_turn requires another native request and is not an end_turn.
          default: terminal = incomplete('unknown');
        }
        break;
      case 'responses':
        switch (input.rawReason) {
          case 'completed': terminal = input.hasRefusal ? incomplete('refusal') : completed(input.hasToolCalls ? 'tool_calls' : 'stop'); break;
          case 'incomplete':
            terminal = incomplete(input.incompleteReason === 'max_output_tokens' ? 'length'
              : input.incompleteReason === 'content_filter' ? 'content_filter'
              : input.incompleteReason === 'refusal' ? 'refusal' : 'unknown');
            break;
          case 'failed': terminal = { status: 'failed', error: input.error ?? safeError('upstream_error', 'upstream_failed') }; break;
          case 'cancelled': terminal = { status: 'cancelled' }; break;
          case 'queued': case 'in_progress': return { ok: false, error: safeError('invalid_response', 'nonterminal_response_status') };
          default: terminal = incomplete('unknown');
        }
        break;
    }
  }
  const finishReason: FinishReason | null = terminal.status === 'completed' ? terminal.reason
    : terminal.status === 'incomplete' && terminal.reason !== 'unexpected_eof' ? terminal.reason : null;
  return { ok: true, value: { from: input.from, rawReason: input.rawReason, incompleteReason: input.incompleteReason ?? null, terminal, finishReason } };
}

/**
 * Maps shared semantics to native target fields. Errors use the target's normal
 * error adapter; cancellation emits no completion event. A refusal for Chat or
 * Responses needs content-field/block conversion. A refusal plan is available
 * only with actual refusal payload; its stop/completed marker MUST accompany
 * that native refusal field/block, never an ordinary visible text response.
 */
export function mapFinishToTarget(source: NormalizedFinish, to: Protocol, options: TargetFinishOptions = {}): ConversionResult<TargetFinish> {
  const terminal = source.terminal;
  const native = (fields: NativeTarget): ConversionResult<TargetFinish> => ({ ok: true, value: { ...fields, kind: 'native', source } });
  const error = (cause: ProtocolError): ConversionResult<TargetFinish> => ({ ok: true, value: { kind: 'error', to, source, error: cause } });
  if (terminal.status === 'cancelled') return { ok: true, value: { kind: 'cancelled', to, source } };
  if (terminal.status === 'failed') return error(terminal.error);
  if (terminal.status === 'completed') {
    if (to === 'chat') return native({ to, finish_reason: terminal.reason === 'tool_calls' ? 'tool_calls' : 'stop' });
    if (to === 'messages') return native({ to, stop_reason: terminal.reason === 'tool_calls' ? 'tool_use' : 'end_turn' });
    return native({ to, status: 'completed', incomplete_details: null });
  }
  switch (terminal.reason) {
    case 'length':
      if (to === 'chat') return native({ to, finish_reason: 'length' });
      if (to === 'messages') return native({ to, stop_reason: source.from === 'messages' && source.rawReason === 'model_context_window_exceeded' ? 'model_context_window_exceeded' : 'max_tokens' });
      return native({ to, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    case 'content_filter':
      if (to === 'chat') return native({ to, finish_reason: 'content_filter' });
      if (to === 'responses') return native({ to, status: 'incomplete', incomplete_details: { reason: 'content_filter' } });
      return error(safeError('unsupported_feature', 'unrepresentable_content_filter'));
    case 'refusal':
      if (to === 'messages') return native({ to, stop_reason: 'refusal' });
      if (typeof options.refusalPayload?.refusal !== 'string') return { ok: false, error: safeError('unsupported_feature', 'refusal_payload_required') };
      return { ok: true, value: {
        kind: 'refusal', source, requiresRefusalPayload: true,
        refusalPayload: { refusal: options.refusalPayload.refusal },
        ...(to === 'chat' ? { to, finish_reason: 'stop', refusalField: 'message.refusal' } as const
          : { to, status: 'completed', refusalField: 'output[].content[].refusal' } as const),
      } };
    case 'unexpected_eof': return error(safeError('stream_error', 'unexpected_eof'));
    case 'unknown': return error(safeError('invalid_response', 'unknown_finish_reason'));
  }
}
