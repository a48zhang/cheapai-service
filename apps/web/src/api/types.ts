/** Management /api/v1 contracts only; never wrap native /v1 model JSON or SSE. */
export type AmountString = string;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface SuccessEnvelope<T> { readonly data: T; readonly request_id: string }
export type ApiErrorCode = 'invalid_request' | 'unauthorized' | 'insufficient_balance' | 'forbidden' | 'not_found'
  | 'conflict' | 'payload_too_large' | 'rate_limited' | 'internal_error' | 'service_unavailable';
export interface ErrorEnvelope { readonly error: { readonly code: string; readonly message: string }; readonly request_id: string }
export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;
export interface Page<T> { readonly items: readonly T[]; readonly nextCursor: string | null }
export interface PaginationQuery { readonly cursor?: string | null; readonly limit?: number }
export type QueryScalar = string | number | boolean;
export type ApiQuery = Readonly<Record<string, QueryScalar | readonly QueryScalar[] | null | undefined>>;
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ApiClientErrorKind = 'api' | 'http' | 'network' | 'invalid_response' | 'aborted' | 'request';

export interface ApiRequestOptions<T = unknown> {
  readonly method?: ApiMethod;
  readonly query?: ApiQuery;
  readonly body?: JsonValue;
  readonly signal?: AbortSignal;
  /** Explicit write-operation key. Reuse it only for retries of the same payload.
   * Shared backend format: 1–128 ASCII characters, first alphanumeric, then
   * alphanumeric/dot/underscore/hyphen. No arbitrary headers are exposed.
   */
  readonly idempotencyKey?: string;
  /** Optional resource schema decoder; the client otherwise checks the envelope only. */
  readonly decode?: (data: unknown) => T;
  /** Explicit bootstrap exception only where the server permits unauthenticated writes. */
  readonly csrf?: 'required' | 'if-available';
}
export interface ApiClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly getCsrfToken?: () => string | null | undefined | Promise<string | null | undefined>;
}
