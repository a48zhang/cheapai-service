import { ApiClientError } from '@cheapai/api-client/errors';

/** Add actionable context without discarding transport diagnostics or the original cause. */
export function withErrorContext(cause: unknown, message: string): Error {
  if (cause instanceof ApiClientError) {
    return new ApiClientError(cause.kind, message, {
      ...(cause.status === null ? {} : { status: cause.status }),
      code: cause.code,
      ...(cause.request_id === null ? {} : { request_id: cause.request_id }),
      cause,
    });
  }
  return new Error(message, { cause });
}
