import { readDiagnosticBody } from './diagnostic-body';
import type { ProtocolError } from '@sub2api/apicompat/types/shared';
import type { RequestRecord } from './request-repository';
import { redactDiagnosticText } from './diagnostic-redaction';

export type FailureSource = 'provider_http' | 'provider_stream' | 'provider_response' | 'response_format' | 'adapter' | 'transport' | 'lifecycle' | 'internal' | 'persistence' | 'accounting' | 'admission' | 'chat_bridge';
export type DiagnosticIdentity = Pick<RequestRecord, 'id'> & Partial<Pick<RequestRecord, 'channel_id' | 'public_model_id' | 'upstream_model' | 'downstream_protocol' | 'upstream_protocol'>>;
export interface ExecutionDiagnostic {
  stage: 'stream_start' | 'stream_terminal' | 'json_response' | 'json_execution' | 'dispatch' | 'chat_bridge' | 'chat_persistence' | 'settlement' | 'recovery' | 'cleanup';
  source: FailureSource;
  code: string;
  error?: Pick<ProtocolError, 'kind' | 'code'> & Partial<Pick<ProtocolError, 'param' | 'message'>>;
  response?: Response;
  cause?: unknown;
  provider?: ProviderDiagnostic;
  note?: string;
}

/** Bounded error fields only: never serialize whole exceptions, frames or bodies.
 * Redact before bounding so a truncated credential cannot escape as a prefix.
 * Logging is best effort and cannot change forwarding, settlement or cleanup.
 */
export function logExecutionFailure(identity: DiagnosticIdentity, details: ExecutionDiagnostic, secrets: readonly string[] = []): void {
  try {
    const safe = (value: string | null | undefined) => value == null ? null : safeDiagnosticText(value, secrets);
    const response = details.response;
    console.error(JSON.stringify({
      event: 'gateway_execution_failure',
      request_id: safe(identity.id), channel_id: safe(identity.channel_id),
      public_model_id: safe(identity.public_model_id), upstream_model: safe(identity.upstream_model),
      downstream_protocol: identity.downstream_protocol, upstream_protocol: identity.upstream_protocol,
      stage: details.stage, failure_source: details.source, failure_code: safe(details.code),
      terminal_error_kind: safe(details.error?.kind), terminal_error_code: safe(details.error?.code),
      terminal_error_param: safe(details.error?.param), terminal_error_reason: safe(details.error?.message),
      causes: diagnosticCauses(details.cause, secrets),
      provider_error: details.provider ? {
        code: safe(details.provider.code), type: safe(details.provider.type), message: safe(details.provider.message), param: safe(details.provider.param),
      } : null,
      diagnostic_note: safe(details.note),
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


export interface ProviderDiagnostic { code?: string; type?: string; message?: string; param?: string }
export function providerDiagnostic(value: unknown): ProviderDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const response = row.response && typeof row.response === 'object' ? row.response as Record<string, unknown> : undefined;
  const error = row.error ?? response?.error ?? (row.type === 'error' ? row : undefined);
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const fields = error as Record<string, unknown>;
  const result: ProviderDiagnostic = {};
  for (const key of ['code', 'type', 'message', 'param'] as const) if (typeof fields[key] === 'string') result[key] = fields[key];
  return result;
}

/** Known request text is used only as a redaction dictionary, never emitted. */
export function requestDiagnosticSecrets(value: unknown): string[] {
  const secrets: string[] = [];
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === 'string') { if (next.length > 0) secrets.push(next); }
    else if (next && typeof next === 'object' && !seen.has(next)) {
      seen.add(next);
      for (const [key, entry] of Object.entries(next)) if (!['model', 'role', 'type'].includes(key)) pending.push(entry);
    }
  }
  return secrets;
}

export function safeDiagnosticText(value: string, secrets: readonly string[] = []): string {
  // redactDiagnosticText bounds its credential dictionary; apply every batch.
  let text = value;
  for (const secret of secrets) if (secret.length > 16384) text = text.split(secret).join('[REDACTED]');
  for (let i = 0; i < Math.max(1, secrets.length); i += 32) text = redactDiagnosticText(text, secrets.slice(i, i + 32)).text;
  return text.slice(0, 512);
}

function diagnosticCauses(error: unknown, secrets: readonly string[]): Record<string, string | null>[] {
  const results: Record<string, string | null>[] = [];
  const seen = new Set<unknown>();
  while (error && !seen.has(error) && results.length < 4) {
    seen.add(error);
    if (!(error instanceof Error)) break;
    const e = error as Error & { code?: unknown; reason?: unknown; diagnosticCause?: unknown };
    // SyntaxError can quote input bytes. Retain its category, never its excerpt.
    results.push({ name: safeDiagnosticText(e.name, secrets),
      code: typeof e.code === 'string' ? safeDiagnosticText(e.code, secrets) : typeof e.reason === 'string' ? safeDiagnosticText(e.reason, secrets) : null,
      message: e instanceof SyntaxError ? `Invalid JSON syntax (input excerpt omitted)${/position [0-9]+/.exec(e.message)?.[0] ? '; ' + /position [0-9]+/.exec(e.message)![0] : ''}` : safeDiagnosticText(e.message, secrets) });
    error = e.diagnosticCause ?? e.cause;
  }
  return results;
}


/** Failure responses only. Extract error fields, never log the captured body. */
export async function captureProviderFailure(response: Response, cancel: () => void): Promise<{ provider?: ProviderDiagnostic; note: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const captured = await Promise.race([
      readDiagnosticBody(response.body, 8192),
      new Promise<null>(resolve => { timer = setTimeout(() => { cancel(); resolve(null); }, 1000); }),
    ]);
    if (!captured) return { note: 'provider_error_capture_timeout' };
    if (!captured.complete) return { note: captured.truncated ? 'provider_error_body_over_8192_bytes' : 'provider_error_body_incomplete' };
    let parsed: unknown;
    try { parsed = JSON.parse(captured.text); } catch { return { note: 'provider_error_body_not_json' }; }
    const provider = providerDiagnostic(parsed);
    return provider ? { provider, note: 'provider_error_fields_captured' } : { note: 'provider_error_fields_absent' };
  } catch { return { note: 'provider_error_capture_failed' }; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
