import type { ProtocolError } from '@sub2api/apicompat/types/shared';
import type { RequestRecord } from './request-repository';
import { redactDiagnosticText } from './diagnostic-redaction';

export type FailureSource = 'provider_http' | 'provider_stream' | 'provider_response' | 'response_format' | 'adapter' | 'transport' | 'lifecycle' | 'internal';
type Identity = Pick<RequestRecord, 'id' | 'channel_id' | 'public_model_id' | 'upstream_model' | 'downstream_protocol' | 'upstream_protocol'>;
export interface ExecutionDiagnostic {
  stage: 'stream_start' | 'stream_terminal' | 'json_response' | 'json_execution';
  source: FailureSource;
  code: string;
  error?: Pick<ProtocolError, 'kind' | 'code'>;
  response?: Response;
}

/** Metadata only: never serialize exceptions, provider messages, frames or bodies.
 * Redact before bounding so a truncated credential cannot escape as a prefix.
 * Logging is best effort and cannot change forwarding, settlement or cleanup.
 */
export function logExecutionFailure(identity: Identity, details: ExecutionDiagnostic, secrets: readonly string[] = []): void {
  try {
    const safe = (value: string | null | undefined) => value == null ? null : redactDiagnosticText(value, secrets).text.slice(0, 256);
    const response = details.response;
    console.error(JSON.stringify({
      event: 'gateway_execution_failure',
      request_id: safe(identity.id), channel_id: safe(identity.channel_id),
      public_model_id: safe(identity.public_model_id), upstream_model: safe(identity.upstream_model),
      downstream_protocol: identity.downstream_protocol, upstream_protocol: identity.upstream_protocol,
      stage: details.stage, failure_source: details.source, failure_code: safe(details.code),
      terminal_error_kind: safe(details.error?.kind), terminal_error_code: safe(details.error?.code),
      upstream_status: response?.status ?? null,
      upstream_content_type: safe(response?.headers.get('content-type')?.split(';', 1)[0]),
      upstream_request_id: safe(response?.headers.get('request-id') ?? response?.headers.get('x-request-id') ?? response?.headers.get('x-amzn-requestid')),
    }));
  } catch { /* Diagnostics must never affect the request lifecycle. */ }
}

export function streamFailureSource(code: string): FailureSource {
  if (code === 'upstream_error') return 'provider_stream';
  if (['headers_timeout', 'idle_timeout', 'request_timeout', 'network_error', 'stream_error', 'transport_error'].includes(code)) return 'transport';
  if (['lease_lost', 'cancelled', 'completion_timeout'].includes(code)) return 'lifecycle';
  if (['unexpected_eof', 'stream_processing_failed'].includes(code)) return 'response_format';
  return 'adapter';
}
