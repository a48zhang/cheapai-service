import type { ChannelProbeResult } from '@cheapai/contracts/channels';
import type { ProbeEvidence } from '@cheapai/contracts/channel-diagnostics';
import {
  CHANNEL_PROBE_MAX_OUTPUT_TOKENS,
  createChannelProbeBody,
} from '@cheapai/contracts/channel-probe';
import type { ChannelProbeProtocol } from '@cheapai/contracts/channel-probe';
import { readDiagnosticBody, DIAGNOSTIC_RESPONSE_MAX_BYTES } from './diagnostic-body';
import type { DiagnosticBodyCapture } from './diagnostic-body';
import {
  redactDiagnosticBody,
  redactDiagnosticError,
  redactDiagnosticHeaders,
  redactDiagnosticText,
  redactDiagnosticUrl,
} from './diagnostic-redaction';
import { validateDiagnosticResponse } from './diagnostic-validation';
import type { DiagnosticValidationIssue } from './diagnostic-validation';
import { sendUpstream, UpstreamTransportError } from './transport';
import type {
  UpstreamFetch,
  UpstreamTransportObservation,
  UpstreamTransportRequestSnapshot,
} from './transport';

const MAX_DIAGNOSTIC_DURATION_MS = 10_000;

export interface RunChannelDiagnosticOptions {
  baseUrl: string;
  upstreamKey: string;
  protocol: ChannelProbeProtocol;
  upstreamModel: string;
  publicModelId: string;
  diagnosticId: string;
  requestId: string;
  startedAt: number;
  timeoutMs: number;
  maxOutputTokens: number;
  signal?: AbortSignal;
  now?: () => number;
  fetch?: UpstreamFetch;
}

export interface ChannelDiagnosticRunResult {
  outcome: ChannelProbeResult['outcome'];
  upstreamStatus: number | null;
  evidence: ProbeEvidence;
}

type PhaseName = 'probe_configuration' | 'dispatch' | 'headers' | 'body' | 'validation';
type PhaseState = 'completed' | 'failed' | 'skipped';
type FailureSource = NonNullable<ProbeEvidence['failure']>['source'];
type FailurePhase = NonNullable<ProbeEvidence['failure']>['phase'];
type ResponseFormat = NonNullable<ProbeEvidence['response']>['format'];

interface PhaseTiming {
  startedAt: number;
  endedAt?: number;
  state?: PhaseState;
}

function finiteTime(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function elapsedSince(start: number, end: number): number {
  return Math.max(0, finiteTime(end - start));
}

function cleanText(
  value: string,
  maxLength: number,
  secrets: readonly string[],
  fallback: string,
): string {
  const text = redactDiagnosticText(value, secrets)
    .text.replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
  return text || fallback;
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function providerError(
  text: string,
  secrets: readonly string[],
): ReturnType<typeof redactDiagnosticError> | null {
  const parsed = parseJson(text);
  const root = record(parsed);
  if (root === null) return null;
  const nested = root.error;
  const errorRecord = record(nested);
  const codeValue =
    errorRecord?.code ??
    (errorRecord?.type === 'error' ? undefined : errorRecord?.type) ??
    root.code ??
    (root.type === 'error' ? undefined : root.type);
  const messageValue = typeof nested === 'string' ? nested : (errorRecord?.message ?? root.message);
  if (codeValue === undefined && messageValue === undefined) return null;
  return redactDiagnosticError({ code: codeValue, message: messageValue }, secrets);
}

function responseFormat(
  contentType: string | null,
  capture: DiagnosticBodyCapture,
): ResponseFormat {
  if (capture.truncated || !capture.complete || capture.error !== null) return 'fragment';
  if (capture.capturedBytes === 0) return 'empty';
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json' && !mediaType.endsWith('+json')) return 'text';
  return isJson(capture.text) ? 'json' : 'text';
}

function requestEvidence(
  request: UpstreamTransportRequestSnapshot,
  options: RunChannelDiagnosticOptions,
  secrets: readonly string[],
): NonNullable<ProbeEvidence['request']> {
  const url = redactDiagnosticUrl(request.url, secrets);
  const headers = redactDiagnosticHeaders(request.init.headers, 'request', secrets);
  const body = redactDiagnosticBody(request.init.body ?? null, { secrets });
  return {
    method: cleanText(request.init.method, 16, secrets, 'POST'),
    url: cleanText(url.text, 2_048, secrets, '[REDACTED URL]'),
    headers: headers.headers,
    body: body.body,
    publicModelId: cleanText(options.publicModelId, 128, secrets, 'unknown-model'),
    upstreamModel: cleanText(options.upstreamModel, 128, secrets, '[REDACTED MODEL]'),
  };
}

function safeIssues(
  issues: readonly DiagnosticValidationIssue[],
  secrets: readonly string[],
): Array<{ path: string; message: string }> {
  return issues.slice(0, 64).map((issue) => ({
    path: cleanText(issue.path, 512, secrets, '$'),
    message: cleanText(issue.message, 2_048, secrets, 'The response did not match the protocol.'),
  }));
}

function transportFailure(
  error: unknown,
  responseReceived: boolean,
  secrets: readonly string[],
): {
  outcome: ChannelProbeResult['outcome'];
  source: FailureSource;
  phase: FailurePhase;
  code: string | null;
  message: string;
} {
  const transportError = error instanceof UpstreamTransportError ? error : null;
  const reason = transportError?.reason;
  const safe = redactDiagnosticError(error, secrets);
  const outcome: ChannelProbeResult['outcome'] =
    reason === 'cancelled'
      ? 'cancelled'
      : reason?.endsWith('_timeout') === true
        ? 'timeout'
        : 'transport_error';
  const phase: FailurePhase =
    reason === 'invalid_configuration'
      ? 'configuration'
      : reason === 'headers_timeout' || (!responseReceived && reason === 'request_timeout')
        ? 'headers'
        : responseReceived || reason === 'idle_timeout' || reason === 'stream_error'
          ? 'body'
          : 'dispatch';
  return {
    outcome,
    source: reason === 'invalid_configuration' ? 'cheapai' : 'transport',
    phase,
    code: safe.code ?? reason ?? null,
    message:
      safe.message ||
      (reason ? `Upstream transport failed: ${reason}` : 'The diagnostic transport failed.'),
  };
}

/** Run one fixed, bounded channel probe and return only redacted evidence. */
export async function runChannelDiagnostic(
  options: RunChannelDiagnosticOptions,
): Promise<ChannelDiagnosticRunResult> {
  const now = options.now ?? Date.now;
  const secrets =
    typeof options.upstreamKey === 'string' && options.upstreamKey.length > 0
      ? [options.upstreamKey]
      : [];
  const startedAt =
    Number.isSafeInteger(options.startedAt) && options.startedAt >= 0
      ? options.startedAt
      : Math.max(0, Math.floor(now()));
  const evidence: ProbeEvidence = {
    requestId: cleanText(options.requestId, 128, secrets, 'unknown-request'),
    startedAt,
    durationMs: 0,
    execution: 'not_started',
    request: null,
    redirects: [],
    response: null,
    failure: null,
    phases: [],
  };
  const phaseOrder: PhaseName[] = [
    'probe_configuration',
    'dispatch',
    'headers',
    'body',
    'validation',
  ];
  const phaseTimes = new Map<PhaseName, PhaseTiming>();
  let outcome: ChannelProbeResult['outcome'] = 'transport_error';
  let upstreamStatus: number | null = null;
  let responseContentType: string | null = null;
  let observedResponseHeaders: { status: number; url: string; headers: Headers } | null = null;
  let finalResponseReceived = false;
  let exchange: Awaited<ReturnType<typeof sendUpstream>> | undefined;
  let transportError: unknown | null = null;

  const beginPhase = (name: PhaseName): void => {
    if (!phaseTimes.has(name)) phaseTimes.set(name, { startedAt: now() });
  };
  const endPhase = (name: PhaseName, state: PhaseState): void => {
    const timing = phaseTimes.get(name);
    if (!timing || timing.state) return;
    timing.endedAt = now();
    timing.state = state;
  };
  const setFailure = (
    source: FailureSource,
    phase: FailurePhase,
    code: string | null,
    message: string,
    issues: readonly DiagnosticValidationIssue[] = [],
  ): void => {
    const safe = redactDiagnosticError({ code, message }, secrets);
    evidence.failure = {
      source,
      phase,
      code: safe.code,
      message: cleanText(safe.message, 8_192, secrets, 'The diagnostic failed.'),
      issues: safeIssues(issues, secrets),
    };
  };
  const observedResponseUrl = (): string | undefined =>
    (observedResponseHeaders as { status: number; url: string; headers: Headers } | null)?.url;
  const setFinalResponse = (status: number, responseUrl: string, headers: Headers): void => {
    finalResponseReceived = true;
    evidence.execution = 'response_received';
    upstreamStatus = status;
    responseContentType = headers.get('content-type');
    const url = redactDiagnosticUrl(responseUrl, secrets);
    const safeHeaders = redactDiagnosticHeaders(headers, 'response', secrets);
    evidence.response = {
      status,
      url: cleanText(url.text, 2_048, secrets, '[REDACTED URL]'),
      headers: safeHeaders.headers,
      body: '',
      format: 'fragment',
      capturedBytes: 0,
      complete: false,
      truncated: false,
      redacted: url.redacted || safeHeaders.redacted,
    };
  };
  const observe = (event: UpstreamTransportObservation): void => {
    try {
      switch (event.type) {
        case 'prepared': {
          if (event.request.attempt === 1) {
            evidence.request = requestEvidence(event.request, options, secrets);
            endPhase('probe_configuration', 'completed');
            beginPhase('dispatch');
          }
          break;
        }
        case 'attempt':
          if (evidence.execution !== 'response_received') evidence.execution = 'attempted';
          if (event.request.attempt === 1) {
            if (evidence.request === null) {
              evidence.request = requestEvidence(event.request, options, secrets);
              endPhase('probe_configuration', 'completed');
              beginPhase('dispatch');
            }
            endPhase('dispatch', 'completed');
            beginPhase('headers');
          }
          break;
        case 'response_headers': {
          observedResponseHeaders = {
            status: event.status,
            url: event.url,
            headers: new Headers(event.headers),
          };
          break;
        }
        case 'redirect': {
          if (evidence.redirects.length < 20) {
            evidence.redirects.push({
              url: cleanText(
                redactDiagnosticUrl(event.url, secrets).text,
                2_048,
                secrets,
                '[REDACTED URL]',
              ),
              nextUrl: cleanText(
                redactDiagnosticUrl(event.nextUrl, secrets).text,
                2_048,
                secrets,
                '[REDACTED URL]',
              ),
              method: cleanText(event.method, 16, secrets, 'POST'),
              status: event.status,
              strippedHeaders: event.strippedHeaders
                .slice(0, 32)
                .map((name) => cleanText(name, 128, secrets, '[REDACTED]')),
            });
          }
          observedResponseHeaders = null;
          break;
        }
        case 'complete': {
          const headers =
            observedResponseHeaders?.status === event.status &&
            observedResponseHeaders.url === event.url
              ? observedResponseHeaders.headers
              : new Headers();
          setFinalResponse(event.status, event.url, headers);
          endPhase('headers', 'completed');
          break;
        }
      }
    } catch {
      /* Transport also guards callbacks; observation cannot interrupt the probe. */
    }
  };

  beginPhase('probe_configuration');
  try {
    const timeoutMs =
      Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 1
        ? Math.min(options.timeoutMs, MAX_DIAGNOSTIC_DURATION_MS)
        : 0;
    const maxOutputTokens =
      Number.isSafeInteger(options.maxOutputTokens) && options.maxOutputTokens >= 1
        ? Math.min(options.maxOutputTokens, CHANNEL_PROBE_MAX_OUTPUT_TOKENS)
        : 0;
    if (timeoutMs < 1 || maxOutputTokens < 1) throw new RangeError('Invalid diagnostic limits.');

    const body = JSON.stringify(
      createChannelProbeBody(options.protocol, options.upstreamModel, maxOutputTokens),
    );
    const sendOptions = {
      baseUrl: options.baseUrl,
      upstreamProtocol: options.protocol,
      upstreamKey: options.upstreamKey,
      body,
      stream: false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      maxDurationMs: timeoutMs,
      headersTimeoutMs: Math.min(3_000, timeoutMs),
      idleTimeoutMs: Math.min(3_000, timeoutMs),
    };
    const dependencies =
      options.fetch === undefined
        ? { observer: { onEvent: observe } }
        : { fetch: options.fetch, observer: { onEvent: observe } };
    try {
      exchange = await sendUpstream(sendOptions, dependencies);
    } catch (error) {
      transportError = error;
    }

    if (exchange !== undefined) {
      const responseHeaders = new Headers(exchange.response.headers);
      if (!finalResponseReceived) {
        setFinalResponse(
          exchange.response.status,
          exchange.response.url || observedResponseUrl() || '[UNAVAILABLE]',
          responseHeaders,
        );
      } else {
        upstreamStatus = exchange.response.status;
        responseContentType = responseHeaders.get('content-type');
        if (evidence.response !== null) {
          const safeHeaders = redactDiagnosticHeaders(responseHeaders, 'response', secrets);
          evidence.response.status = exchange.response.status;
          evidence.response.headers = safeHeaders.headers;
          evidence.response.redacted ||= safeHeaders.redacted;
        }
      }
      beginPhase('body');
      const capture = await readDiagnosticBody(
        exchange.response.body,
        DIAGNOSTIC_RESPONSE_MAX_BYTES,
      );
      const completion = await exchange.done;
      endPhase(
        'body',
        capture.error === null && (completion.ok || capture.truncated) ? 'completed' : 'failed',
      );

      const bodyReadError =
        capture.error ??
        (!completion.ok && (!capture.truncated || completion.error.reason !== 'cancelled')
          ? completion.error
          : null);
      const safeBody = redactDiagnosticBody(capture.text, {
        secrets,
        truncated: capture.truncated || !capture.complete || bodyReadError !== null,
      });
      const responseUrl = evidence.response?.url ?? '[UNAVAILABLE]';
      const safeResponseHeaders = redactDiagnosticHeaders(responseHeaders, 'response', secrets);
      evidence.response = {
        status: exchange.response.status,
        url: responseUrl,
        headers: safeResponseHeaders.headers,
        body: safeBody.body ?? '',
        format:
          capture.capturedBytes === 0 && bodyReadError === null && capture.complete
            ? 'empty'
            : capture.truncated || !capture.complete || bodyReadError !== null
              ? 'fragment'
              : responseFormat(responseContentType, capture),
        capturedBytes: Math.min(capture.capturedBytes, DIAGNOSTIC_RESPONSE_MAX_BYTES),
        complete: capture.complete && bodyReadError === null && !safeBody.truncated,
        truncated: capture.truncated || safeBody.truncated,
        redacted:
          safeBody.redacted || safeResponseHeaders.redacted || evidence.response?.redacted === true,
      };

      if (bodyReadError !== null) {
        const classified = transportFailure(bodyReadError, true, secrets);
        outcome = classified.outcome;
        const provider = providerError(safeBody.body ?? '', secrets);
        setFailure(
          classified.source,
          'body',
          provider?.code ?? classified.code,
          provider?.message ?? classified.message,
        );
        endPhase('validation', 'skipped');
      } else if (!exchange.response.ok) {
        outcome = 'http_error';
        endPhase('validation', 'skipped');
        const provider = providerError(safeBody.body ?? '', secrets);
        const fallbackMessage =
          safeBody.body?.trim() || `Upstream returned HTTP ${exchange.response.status}.`;
        const failure = provider ?? redactDiagnosticError({ message: fallbackMessage }, secrets);
        setFailure('upstream', 'headers', failure.code, failure.message);
      } else {
        beginPhase('validation');
        const validation = validateDiagnosticResponse({
          protocol: options.protocol,
          contentType: responseContentType,
          bytes: capture.bytes,
          complete: capture.complete,
          truncated: capture.truncated,
          diagnosticId: options.diagnosticId,
          model: options.upstreamModel,
        });
        if (validation.valid) {
          outcome = 'responded';
          evidence.failure = null;
          endPhase('validation', 'completed');
        } else {
          outcome = 'invalid_response';
          endPhase('validation', 'failed');
          const provider = providerError(safeBody.body ?? '', secrets);
          const firstIssue = validation.issues[0];
          setFailure(
            provider ? 'upstream' : 'protocol',
            'validation',
            provider?.code ?? validation.kind,
            provider?.message ??
              firstIssue?.message ??
              'The upstream response did not match the configured protocol.',
            validation.issues,
          );
        }
      }
    } else {
      const error =
        transportError ?? new Error('The diagnostic transport did not return a response.');
      if (
        error instanceof UpstreamTransportError &&
        error.reason === 'cancelled' &&
        error.execution === 'not_started'
      ) {
        endPhase('probe_configuration', 'completed');
        beginPhase('dispatch');
        endPhase('dispatch', 'skipped');
      } else if (phaseTimes.get('probe_configuration')?.state === undefined) {
        endPhase('probe_configuration', 'failed');
      }
      if (phaseTimes.get('dispatch')?.state === undefined && phaseTimes.has('dispatch')) {
        endPhase('dispatch', evidence.execution === 'not_started' ? 'skipped' : 'failed');
      }
      if (phaseTimes.get('headers')?.state === undefined && phaseTimes.has('headers'))
        endPhase('headers', 'failed');
      const classified = transportFailure(error, finalResponseReceived, secrets);
      outcome = classified.outcome;
      setFailure(classified.source, classified.phase, classified.code, classified.message);
      endPhase('body', 'skipped');
      endPhase('validation', 'skipped');
    }
  } catch (error) {
    const safe = redactDiagnosticError(error, secrets);
    const responseReceived = finalResponseReceived;
    outcome = 'transport_error';
    setFailure(
      responseReceived ? 'transport' : 'cheapai',
      responseReceived ? 'body' : 'configuration',
      safe.code,
      safe.message,
    );
    for (const name of phaseOrder) {
      if (phaseTimes.get(name)?.state === undefined && phaseTimes.has(name))
        endPhase(name, name === 'probe_configuration' ? 'failed' : 'skipped');
    }
  } finally {
    try {
      exchange?.cancel();
    } catch {
      /* Keep the already collected partial evidence. */
    }
    if (phaseTimes.get('probe_configuration')?.state === undefined)
      endPhase('probe_configuration', 'skipped');
    if (phaseTimes.get('dispatch')?.state === undefined)
      endPhase('dispatch', evidence.execution === 'not_started' ? 'skipped' : 'completed');
    if (phaseTimes.get('headers')?.state === undefined)
      endPhase('headers', finalResponseReceived ? 'completed' : 'skipped');
    if (phaseTimes.get('body')?.state === undefined)
      endPhase('body', evidence.response === null ? 'skipped' : 'completed');
    if (phaseTimes.get('validation')?.state === undefined)
      endPhase(
        'validation',
        evidence.response === null ||
          upstreamStatus === null ||
          upstreamStatus < 200 ||
          upstreamStatus >= 300
          ? 'skipped'
          : 'completed',
      );
  }

  const finishedAt = now();
  evidence.durationMs = elapsedSince(startedAt, finishedAt);
  evidence.phases = phaseOrder.map((name) => {
    const timing = phaseTimes.get(name);
    return timing === undefined
      ? { name, durationMs: null, state: 'skipped' as const }
      : {
          name,
          durationMs: elapsedSince(timing.startedAt, timing.endedAt ?? finishedAt),
          state: timing.state ?? 'skipped',
        };
  });

  return { outcome, upstreamStatus, evidence };
}
