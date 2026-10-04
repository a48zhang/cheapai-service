import { z } from 'zod';

/** Exact, opaque cursor returned by the API. A null value marks the final page. */
export type Cursor = string | null;

/** Request IDs are opaque protocol values and must stay strings end to end. */
export type RequestId = string;

/** JSON values accepted by the management API client. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** The wire envelope used by management API success responses. */
export interface SuccessEnvelope<T> {
  readonly data: T;
  readonly request_id: RequestId;
}

/** Error details returned by the Worker. Unknown codes remain valid protocol values. */
export interface ErrorBody {
  readonly code: string;
  readonly message: string;
}

/** The wire envelope used by management API error responses. */
export interface ErrorEnvelope {
  readonly error: ErrorBody;
  readonly request_id: RequestId;
}

export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

/** Cursor pages use camelCase `nextCursor` on the wire. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: Cursor;
}

export interface PaginationQuery {
  readonly cursor?: Cursor;
  readonly limit?: number;
}

/** Native Fetch-compatible injection point for browser, tests, and local proxy clients. */
export type FetchImplementation = typeof globalThis.fetch;

export const requestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/[\u0000-\u0020\u007f]/u.test(value), 'Invalid request ID');

export const cursorSchema = z.string().nullable();

export const errorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const errorEnvelopeSchema = z.object({
  error: errorBodySchema,
  request_id: requestIdSchema,
});

export const successEnvelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    data,
    request_id: requestIdSchema,
  });

export const apiEnvelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.union([successEnvelopeSchema(data), errorEnvelopeSchema]);

export const pageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: cursorSchema,
  });
