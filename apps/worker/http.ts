// Management APIs (/api/v1) only. Gateway JSON/SSE uses its native protocol.
export const API_ERRORS = {
  invalid_request: { status: 400, message: 'Invalid request.' },
  unauthorized: { status: 401, message: 'Authentication required.' },
  insufficient_balance: { status: 402, message: 'Insufficient balance.' },
  forbidden: { status: 403, message: 'Permission denied.' },
  not_found: { status: 404, message: 'Resource not found.' },
  conflict: { status: 409, message: 'Resource conflict.' },
  payload_too_large: { status: 413, message: 'Request body too large.' },
  rate_limited: { status: 429, message: 'Too many requests.' },
  internal_error: { status: 500, message: 'Internal server error.' },
  service_unavailable: { status: 503, message: 'Service temporarily unavailable.' },
} as const;

export type ApiErrorCode = keyof typeof API_ERRORS;
export type AmountString = string;

export interface SuccessEnvelope<T> {
  data: T;
  request_id: string;
}

export interface ErrorEnvelope {
  error: { code: ApiErrorCode; message: string };
  request_id: string;
}

export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode) {
    super(API_ERRORS[code].message);
    this.name = 'ApiError';
  }
}

export function createRequestId(): string {
  return crypto.randomUUID();
}

// Pass the server-generated ID from request context to preserve trace continuity.
// Amount fields must already be strings; this helper never parses or rounds them.
export function apiSuccess<T>(data: T, requestId: string, status: 200 | 201 | 202 = 200): Response {
  const body: SuccessEnvelope<T> = { data, request_id: requestId };
  return Response.json(body, { status });
}

export function apiError(error: unknown, requestId: string): Response {
  const code = error instanceof ApiError && Object.hasOwn(API_ERRORS, error.code)
    ? error.code
    : 'internal_error';
  const definition = API_ERRORS[code];
  // Never serialize exception messages, causes, stacks, or upstream response bodies.
  const body: ErrorEnvelope = {
    error: { code, message: definition.message },
    request_id: requestId,
  };
  return Response.json(body, { status: definition.status });
}

export interface Pagination {
  cursor: string | null;
  limit: number;
}

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
export const MAX_CURSOR_LENGTH = 1024;

export function parsePagination(query: URLSearchParams): Pagination {
  if (query.getAll('limit').length > 1 || query.getAll('cursor').length > 1) {
    throw new ApiError('invalid_request');
  }
  const rawLimit = query.get('limit');
  if (rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit)) {
    throw new ApiError('invalid_request');
  }
  const limit = rawLimit === null ? DEFAULT_PAGE_LIMIT : Number(rawLimit);
  if (limit > MAX_PAGE_LIMIT) {
    throw new ApiError('invalid_request');
  }
  const cursor = query.get('cursor');
  // Opaque, unpadded base64url token. Each list endpoint validates its decoded
  // sort keys and scope before constructing parameterized database queries.
  if (cursor !== null && (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor))) {
    throw new ApiError('invalid_request');
  }
  return { cursor, limit };
}
