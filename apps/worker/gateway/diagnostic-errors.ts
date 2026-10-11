import {
  channelDiagnosticErrorDetailsSchema,
  type ChannelDiagnosticErrorDetails,
  type ProbeEvidence,
} from '@cheapai/contracts/channel-diagnostics';
import { API_ERRORS, ApiError } from '../http';
import type { ApiErrorCode } from '../http';

export interface ChannelDiagnosticApiErrorOptions {
  /** Evidence must already have been passed through redactDiagnosticEvidence. */
  readonly evidence?: ProbeEvidence;
  readonly diagnosticId?: string;
}

function mayIncludeDiagnostic(code: ApiErrorCode): boolean {
  const status = API_ERRORS[code].status;
  return status === 409 || status >= 500;
}

/** Route-local error that can carry only a reviewed, redacted diagnostic snapshot. */
export class ChannelDiagnosticApiError extends ApiError {
  private readonly diagnosticDetails: ChannelDiagnosticErrorDetails | undefined;

  constructor(code: ApiErrorCode, options: ChannelDiagnosticApiErrorOptions = {}) {
    super(code);
    if (!mayIncludeDiagnostic(code) || options.evidence === undefined) {
      this.diagnosticDetails = undefined;
      return;
    }

    const parsed = channelDiagnosticErrorDetailsSchema.safeParse({
      diagnostic: options.evidence,
      ...(options.diagnosticId === undefined ? {} : { diagnosticId: options.diagnosticId }),
    });
    this.diagnosticDetails = parsed.success ? parsed.data : undefined;
  }

  getDetails(): ChannelDiagnosticErrorDetails | undefined {
    return this.diagnosticDetails;
  }
}

interface ChannelDiagnosticErrorEnvelope {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly details?: ChannelDiagnosticErrorDetails;
  };
  readonly request_id: string;
}

/**
 * Error boundary for the admin channel probe only. It intentionally does not
 * call apiError/logError: exception messages, causes, stacks, and provider
 * response bodies must never enter this response or the route's error log.
 */
export function channelDiagnosticApiError(error: unknown, requestId: string): Response {
  const code: ApiErrorCode =
    error instanceof ApiError && Object.hasOwn(API_ERRORS, error.code)
      ? error.code
      : 'internal_error';
  const definition = API_ERRORS[code];
  let details: ChannelDiagnosticErrorDetails | undefined;

  if (mayIncludeDiagnostic(code) && error instanceof ChannelDiagnosticApiError) {
    const parsed = channelDiagnosticErrorDetailsSchema.safeParse(error.getDetails());
    if (parsed.success) details = parsed.data;
  }

  const logMetadata = {
    event: 'Channel diagnostic API error',
    api_code: code,
    request_id: requestId,
    diagnostic_id: details?.diagnosticId ?? null,
    phase: details?.diagnostic.failure?.phase ?? null,
  };
  if (definition.status >= 500) console.error(logMetadata);
  else console.warn(logMetadata);

  const body: ChannelDiagnosticErrorEnvelope = {
    error: {
      code,
      message: definition.message,
      ...(details === undefined ? {} : { details }),
    },
    request_id: requestId,
  };
  return Response.json(body, { status: definition.status });
}
