import type {
  FetchImplementation,
  JsonValue as ContractJsonValue,
  SuccessEnvelope,
} from '@cheapai/contracts/common';

export type {
  ApiEnvelope,
  Cursor,
  ErrorBody,
  ErrorEnvelope,
  FetchImplementation,
  Page,
  PaginationQuery,
  RequestId,
  SuccessEnvelope,
} from '@cheapai/contracts/common';

/** Management /api/v1 contracts only; never wrap native /v1 model JSON or SSE. */
export type JsonValue = ContractJsonValue;
/**
 * Input accepted by JSON.stringify: object members may be undefined and are
 * omitted during serialization. Contract payloads remain typed as JsonValue.
 */
export type JsonInput =
  | null
  | boolean
  | number
  | string
  | readonly JsonInput[]
  | { readonly [key: string]: JsonInput | undefined };
export type QueryScalar = string | number | boolean;
export type ApiQuery = Readonly<
  Record<string, QueryScalar | readonly QueryScalar[] | null | undefined>
>;
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ApiClientErrorKind =
  'api' | 'http' | 'network' | 'invalid_response' | 'aborted' | 'request';

export type ApiErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'insufficient_balance'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal_error'
  | 'service_unavailable';

/** A request snapshot lets the session layer ignore a late 401 from an older identity. */
export interface SessionIdentity {
  readonly userId: string;
  readonly epoch: number;
}

export interface ApiRequestOptions<T = unknown> {
  readonly method?: ApiMethod;
  readonly query?: ApiQuery;
  readonly body?: JsonInput;
  readonly signal?: AbortSignal;
  /** Explicit write-operation key. Reuse it only for retries of the same payload. */
  readonly idempotencyKey?: string;
  /** Optional resource decoder; the client otherwise checks the envelope only. */
  readonly decode?: (data: unknown) => T;
  /** Explicit bootstrap exception only where the server permits unauthenticated writes. */
  readonly csrf?: 'required' | 'if-available';
}

/** Optional cancellation for read-only API requests. */
export interface ApiReadOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface ApiClientOptions {
  readonly fetch?: FetchImplementation;
  readonly getCsrfToken?: () => string | null | undefined | Promise<string | null | undefined>;
  readonly captureIdentity?: () => SessionIdentity | null | undefined;
  readonly onUnauthorized?: (identity: SessionIdentity, path: string) => void;
}

export interface ApiClient {
  request<T = unknown>(path: string, input?: ApiRequestOptions<T>): Promise<SuccessEnvelope<T>>;
  get<T = unknown>(
    path: string,
    input?: Omit<ApiRequestOptions<T>, 'method' | 'body'>,
  ): Promise<SuccessEnvelope<T>>;
  post<T = unknown>(
    path: string,
    body?: JsonInput,
    input?: Omit<ApiRequestOptions<T>, 'method' | 'body'>,
  ): Promise<SuccessEnvelope<T>>;
  put<T = unknown>(
    path: string,
    body?: JsonInput,
    input?: Omit<ApiRequestOptions<T>, 'method' | 'body'>,
  ): Promise<SuccessEnvelope<T>>;
  patch<T = unknown>(
    path: string,
    body?: JsonInput,
    input?: Omit<ApiRequestOptions<T>, 'method' | 'body'>,
  ): Promise<SuccessEnvelope<T>>;
  delete<T = unknown>(
    path: string,
    body?: JsonInput,
    input?: Omit<ApiRequestOptions<T>, 'method' | 'body'>,
  ): Promise<SuccessEnvelope<T>>;
}
