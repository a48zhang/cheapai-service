import type { ProbeEvidence } from '@cheapai/contracts/channel-diagnostics';

const REDACTED = '[REDACTED]';
const MAX_BODY_CHARS = 32_768;
const MAX_KNOWN_SECRETS = 32;

const SENSITIVE_NAMES = new Set([
  'api_key',
  'apikey',
  'xapikey',
  'key',
  'authorization',
  'proxyauthorization',
  'auth',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'secretkey',
  'privatekey',
  'signingkey',
  'token',
  'apitoken',
  'xapitoken',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'sessiontoken',
  'bearertoken',
  'credential',
  'credentials',
]);

const SENSITIVE_QUERY_NAME =
  /^(?:api[_-]?key|key|api[_-]?token|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth(?:orization)?|api[_-]?secret|client[_-]?(?:secret|token)|secret|password|passwd|signature|sig|credential|credentials)$/iu;
const SENSITIVE_HEADER_NAME =
  /(?:authorization|cookie|setcookie|(?:api)?key|secret|password|passwd|token|credential)$/iu;
const SAFE_RESPONSE_HEADERS = new Set([
  'content-type',
  'retry-after',
  'request-id',
  'x-request-id',
  'openai-request-id',
  'anthropic-request-id',
  'x-amzn-requestid',
  'x-amz-request-id',
  'x-goog-request-id',
  'x-correlation-id',
  'x-trace-id',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset',
]);

export interface RedactedText {
  text: string;
  redacted: boolean;
}

export interface RedactedBody {
  body: string | null;
  redacted: boolean;
  /** True when sanitization itself had to shorten the captured text. */
  truncated: boolean;
}

export interface RedactedHeaders {
  headers: Record<string, string>;
  redacted: boolean;
}

export interface RedactedError {
  code: string | null;
  message: string;
}

function secretsFrom(values: readonly string[] = []): string[] {
  return values
    .filter((value) => typeof value === 'string' && value.length > 0 && value.length <= 16_384)
    .slice(0, MAX_KNOWN_SECRETS)
    .sort((left, right) => right.length - left.length);
}

function encodedSecretVariants(secret: string): Array<{ value: string; caseInsensitive: boolean }> {
  const formValue = new URLSearchParams([['secret', secret]]).toString().slice('secret='.length);
  const percentValue = Array.from(
    new TextEncoder().encode(secret),
    (byte) => `%${byte.toString(16).padStart(2, '0')}`,
  ).join('');
  const jsonValue = JSON.stringify(secret).slice(1, -1);
  const escapedJsonValue = Array.from(
    { length: secret.length },
    (_, index) => `\\u${secret.charCodeAt(index).toString(16).padStart(4, '0')}`,
  ).join('');
  const unique = new Map<string, { value: string; caseInsensitive: boolean }>();
  for (const value of [
    encodeURIComponent(secret),
    formValue,
    percentValue,
    jsonValue,
    escapedJsonValue,
  ]) {
    if (value === secret || value.length === 0) continue;
    unique.set(value.toLowerCase(), { value, caseInsensitive: true });
  }
  return [...unique.values()];
}

function isSensitiveField(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/gu, '');
  if (SENSITIVE_NAMES.has(normalized)) return true;
  return /^(?:(?:api|client|private|signing|shared)?(?:key|secret)|(?:access|refresh|id|auth|session|bearer)?token|(?:proxy)?authorization|(?:set)?cookie|password|passwd|credential)s?$/u.test(
    normalized,
  );
}

function replaceMaskedSecretEchoes(input: string, secret: string): RedactedText {
  let redacted = false;
  const text = input.replace(/[A-Za-z0-9_-]*\*{2,}[A-Za-z0-9_-]*/gu, (match) => {
    const firstStar = match.indexOf('*');
    const prefix = match.slice(0, firstStar);
    const suffix = match.slice(match.lastIndexOf('*') + 1);
    if (
      prefix.length + suffix.length >= secret.length ||
      Math.max(prefix.length, suffix.length) < 4 ||
      !secret.startsWith(prefix) ||
      !secret.endsWith(suffix)
    ) {
      return match;
    }
    redacted = true;
    return REDACTED;
  });
  return { text, redacted };
}

function replaceKnownSecrets(input: string, secrets: readonly string[]): RedactedText {
  let text = input;
  let redacted = false;
  for (const secret of secrets) {
    if (text.includes(secret)) {
      text = text.split(secret).join(REDACTED);
      redacted = true;
    }
    for (const variant of encodedSecretVariants(secret)) {
      const escaped = variant.value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const pattern = new RegExp(escaped, variant.caseInsensitive ? 'giu' : 'gu');
      if (!pattern.test(text)) continue;
      pattern.lastIndex = 0;
      text = text.replace(pattern, REDACTED);
      redacted = true;
    }
    const maskedEcho = replaceMaskedSecretEchoes(text, secret);
    text = maskedEcho.text;
    if (maskedEcho.redacted) redacted = true;
  }
  return { text, redacted };
}

function longestPrefixSuffix(input: string, pattern: string, caseInsensitive: boolean): number {
  if (pattern.length === 0 || input.length === 0) return 0;
  const normalize = caseInsensitive
    ? (value: string) => value.toLowerCase()
    : (value: string) => value;
  const needle = normalize(pattern);
  const candidate = normalize(input.slice(-Math.min(input.length, pattern.length)));
  const prefix = new Uint32Array(needle.length);
  for (let index = 1, matched = 0; index < needle.length; index++) {
    while (matched > 0 && needle[index] !== needle[matched]) matched = prefix[matched - 1]!;
    if (needle[index] === needle[matched]) matched++;
    prefix[index] = matched;
  }
  let matched = 0;
  for (let index = 0; index < candidate.length; index++) {
    const character = candidate[index]!;
    while (matched > 0 && character !== needle[matched]) matched = prefix[matched - 1]!;
    if (character === needle[matched]) matched++;
  }
  return matched;
}

function redactSecretTail(input: string, secrets: readonly string[]): RedactedText {
  let longest = 0;
  for (const secret of secrets) {
    longest = Math.max(longest, longestPrefixSuffix(input, secret, false));
    for (const variant of encodedSecretVariants(secret)) {
      longest = Math.max(
        longest,
        longestPrefixSuffix(input, variant.value, variant.caseInsensitive),
      );
    }
  }
  return longest === 0
    ? { text: input, redacted: false }
    : { text: `${input.slice(0, -longest)}${REDACTED}`, redacted: true };
}

function redactSensitiveTextFields(input: string): RedactedText {
  let redacted = false;
  let text = input;

  // JSON string properties and HTML/text assignments, including a value cut off
  // by the 32 KiB capture boundary. The key name is retained for diagnosis.
  const jsonField =
    /("(?:api[_-]?key|x-api-key|api[_-]?token|key|authorization|proxy[_-]?authorization|cookie|set-cookie|password|passwd|secret|client[_-]?secret|private[_-]?key|(?:access|refresh|id|auth|session|bearer)?[_-]?token|credential(?:s)?)"\s*:\s*")((?:\\.|[^"\\])*)(")?/giu;
  text = text.replace(
    jsonField,
    (_match, prefix: string, _value: string, closingQuote: string | undefined) => {
      redacted = true;
      return `${prefix}${REDACTED}${closingQuote ?? ''}`;
    },
  );

  const authAssignment =
    /(?<!["'])\b(authorization|proxy[-_]?authorization)\b(\s*[:=]\s*)[^\r\n<>]*/giu;
  text = text.replace(authAssignment, (_match, name: string, separator: string) => {
    redacted = true;
    return `${name}${separator}${REDACTED}`;
  });

  const cookieAssignment = /(?<!["'])\b(cookie|set[-_]cookie)\b(\s*[:=]\s*)[^\r\n<>]*/giu;
  text = text.replace(cookieAssignment, (_match, name: string, separator: string) => {
    redacted = true;
    return `${name}${separator}${REDACTED}`;
  });

  const assignment =
    /(?<!["'])\b((?:x[-_])?(?:api[-_]?key|api[-_]?token|key|authorization|proxy[-_]?authorization|cookie|set[-_]cookie|password|passwd|secret|client[-_]?secret|private[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|session[-_]?token|credential(?:s)?))\b(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;<>"']+)/giu;
  text = text.replace(assignment, (_match, name: string, separator: string) => {
    redacted = true;
    return `${name}${separator}${REDACTED}`;
  });

  const query =
    /([?&](?:api[_-]?key|key|api[_-]?token|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth(?:orization)?|client[_-]?secret|secret|password|passwd|signature|sig|credential(?:s)?)=)([^&#\s"'<>]*)/giu;
  text = text.replace(query, (_match, prefix: string) => {
    redacted = true;
    return `${prefix}${REDACTED}`;
  });

  return { text, redacted };
}

function redactPlainText(
  input: string,
  secrets: readonly string[],
  truncated = false,
): RedactedText {
  let { text, redacted } = replaceKnownSecrets(input, secrets);
  const fields = redactSensitiveTextFields(text);
  text = fields.text;
  redacted ||= fields.redacted;
  const urls = redactEmbeddedUrls(text, secrets);
  text = urls.text;
  redacted ||= urls.redacted;
  if (truncated) {
    const tail = redactSecretTail(text, secrets);
    text = tail.text;
    redacted ||= tail.redacted;
    const partialField = redactSensitiveTextFields(text);
    text = partialField.text;
    redacted ||= partialField.redacted;
  }
  return { text, redacted };
}

function redactUrlComponent(value: string, secrets: readonly string[]): RedactedText {
  const known = replaceKnownSecrets(value, secrets);
  const sensitive = redactSensitiveTextFields(known.text);
  return { text: sensitive.text, redacted: known.redacted || sensitive.redacted };
}

function redactEmbeddedUrls(input: string, secrets: readonly string[]): RedactedText {
  let redacted = false;
  const text = input.replace(/https?:\/\/[^\s"'<>]+/giu, (match) => {
    const trailing = match.match(/[),.;!?\]}]+$/u)?.[0] ?? '';
    const urlText = trailing.length > 0 ? match.slice(0, -trailing.length) : match;
    if (urlText.length === 0) return match;
    const safe = redactUrlValue(urlText, secrets);
    redacted ||= safe.redacted;
    return `${safe.text}${trailing}`;
  });
  return { text, redacted };
}

function redactUrlValue(input: string, secrets: readonly string[]): RedactedText {
  const literalSafe = replaceKnownSecrets(input, secrets);
  let parsed: URL;
  try {
    parsed = new URL(literalSafe.text);
  } catch {
    const fields = redactSensitiveTextFields(literalSafe.text);
    return { text: fields.text, redacted: literalSafe.redacted || fields.redacted };
  }

  let redacted = literalSafe.redacted;
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
    redacted = true;
  }
  for (const [name, value] of parsed.searchParams.entries()) {
    if (SENSITIVE_QUERY_NAME.test(name)) {
      parsed.searchParams.set(name, REDACTED);
      redacted = true;
      continue;
    }
    const safeValue = redactUrlComponent(value, secrets);
    if (safeValue.redacted) {
      parsed.searchParams.set(name, safeValue.text);
      redacted = true;
    }
  }
  const safeHash = redactUrlComponent(parsed.hash, secrets);
  if (safeHash.redacted) {
    parsed.hash = safeHash.text.replace(/^#/u, '');
    redacted = true;
  }
  const safeUrl = replaceKnownSecrets(parsed.toString(), secrets);
  return { text: safeUrl.text, redacted: redacted || safeUrl.redacted };
}

function boundedText(value: string, max: number, secrets: readonly string[]): RedactedText {
  const safe = redactPlainText(value, secrets, value.length > max);
  if (safe.text.length <= max) return safe;
  let end = Math.max(0, max - REDACTED.length);
  if (end > 0 && /[\uD800-\uDBFF]/u.test(safe.text[end - 1] ?? '')) end--;
  const prefix = safe.text.slice(0, end);
  const tailSafe = redactPlainText(prefix, secrets, true);
  const clipped = tailSafe.text.length <= max ? tailSafe.text : tailSafe.text.slice(0, max);
  return { text: clipped, redacted: true };
}

function sanitizeJsonValue(
  value: unknown,
  secrets: readonly string[],
  depth: number,
): { value: unknown; redacted: boolean } {
  if (depth > 64) return { value: REDACTED, redacted: true };
  if (typeof value === 'string') {
    const safe = redactPlainText(value, secrets);
    return { value: safe.text, redacted: safe.redacted };
  }
  if (Array.isArray(value)) {
    let redacted = false;
    const result = value.map((entry) => {
      const safe = sanitizeJsonValue(entry, secrets, depth + 1);
      redacted ||= safe.redacted;
      return safe.value;
    });
    return { value: result, redacted };
  }
  if (value !== null && typeof value === 'object') {
    let redacted = false;
    const result = Object.create(null) as Record<string, unknown>;
    for (const [name, entry] of Object.entries(value)) {
      const safeName = redactPlainText(name, secrets);
      const outputName = safeName.redacted || name.includes(REDACTED) ? REDACTED : safeName.text;
      redacted ||= safeName.redacted || name.includes(REDACTED);
      if (isSensitiveField(name)) {
        result[outputName] = REDACTED;
        redacted = true;
        continue;
      }
      const safe = sanitizeJsonValue(entry, secrets, depth + 1);
      result[outputName] = safe.value;
      redacted ||= safe.redacted;
    }
    return { value: result, redacted };
  }
  return { value, redacted: false };
}

/** Redact arbitrary provider text without hiding useful code/message fragments. */
export function redactDiagnosticText(
  value: string,
  secrets: readonly string[] = [],
  options: { truncated?: boolean } = {},
): RedactedText {
  return redactPlainText(value, secretsFrom(secrets), options.truncated === true);
}

/** Remove URL credentials and sensitive query values while preserving safe parameters. */
export function redactDiagnosticUrl(url: string, secrets: readonly string[] = []): RedactedText {
  return redactUrlValue(url, secretsFrom(secrets));
}

/** Keep the actual request header names; response headers use a strict allowlist. */
export function redactDiagnosticHeaders(
  input: HeadersInit | Headers,
  kind: 'request' | 'response',
  secrets: readonly string[] = [],
): RedactedHeaders {
  const safeSecrets = secretsFrom(secrets);
  const headers = Object.create(null) as Record<string, string>;
  let redacted = false;
  let source: Headers;
  try {
    source = new Headers(input);
  } catch {
    return { headers, redacted: true };
  }

  for (const [rawName, rawValue] of source.entries()) {
    const lowerName = rawName.toLowerCase();
    const safeName = replaceKnownSecrets(lowerName, safeSecrets);
    const name = safeName.redacted ? REDACTED : lowerName;
    redacted ||= safeName.redacted;
    if (kind === 'response' && !SAFE_RESPONSE_HEADERS.has(name)) {
      redacted = true;
      continue;
    }
    if (Object.keys(headers).length >= 32) {
      redacted = true;
      break;
    }
    if (SENSITIVE_HEADER_NAME.test(name.replace(/[^a-z0-9]/giu, ''))) {
      headers[name] = REDACTED;
      redacted = true;
      continue;
    }
    const safe = boundedText(rawValue, 8_192, safeSecrets);
    headers[name] = safe.text;
    redacted ||= safe.redacted;
  }
  return { headers, redacted };
}

/**
 * Redact captured JSON or text. A known secret prefix at a truncated tail and
 * an unfinished sensitive JSON field are both removed before the text escapes.
 */
export function redactDiagnosticBody(
  body: string | null,
  options: { secrets?: readonly string[]; truncated?: boolean } = {},
): RedactedBody {
  if (body === null) return { body: null, redacted: false, truncated: false };
  const secrets = secretsFrom(options.secrets);
  const safe = redactPlainText(body, secrets, options.truncated === true);
  let output = safe.text;
  let wasRedacted = safe.redacted;
  try {
    const parsed: unknown = JSON.parse(output);
    const sanitized = sanitizeJsonValue(parsed, secrets, 0);
    if (sanitized.redacted) {
      output = JSON.stringify(sanitized.value);
      wasRedacted = true;
    }
  } catch {
    // Non-JSON provider errors stay readable as text; the bounded text scrub above applies.
  }
  const outputTruncated = output.length > MAX_BODY_CHARS;
  if (outputTruncated) {
    const bounded = boundedText(output, MAX_BODY_CHARS, secrets);
    output = bounded.text;
    wasRedacted ||= bounded.redacted;
  }
  return { body: output, redacted: wasRedacted, truncated: outputTruncated };
}

/** Preserve safe provider `code` and `message`; never return stack/cause fields. */
export function redactDiagnosticError(
  error: unknown,
  secrets: readonly string[] = [],
): RedactedError {
  let codeValue: unknown;
  let messageValue: unknown;
  if (typeof error === 'string') messageValue = error;
  else if (error instanceof Error) {
    messageValue = error.message;
    try {
      codeValue = (error as Error & { code?: unknown }).code;
    } catch {
      /* Ignore hostile accessors. */
    }
  } else if (error !== null && typeof error === 'object') {
    try {
      const record = error as Record<string, unknown>;
      codeValue = record.code;
      messageValue = record.message;
    } catch {
      /* Ignore hostile accessors. */
    }
  }
  const code = typeof codeValue === 'string' ? boundedText(codeValue, 128, secrets).text : null;
  const message =
    typeof messageValue === 'string'
      ? boundedText(messageValue, 8_192, secrets).text
      : 'The diagnostic failed.';
  return { code, message: message || 'The diagnostic failed.' };
}

/** Final field-by-field scrub for a partial or complete diagnostic evidence object. */
export function redactDiagnosticEvidence(
  evidence: ProbeEvidence,
  secrets: readonly string[] = [],
): ProbeEvidence {
  const safeSecrets = secretsFrom(secrets);
  const cleanText = (value: string, max: number) => boundedText(value, max, safeSecrets).text;
  const request =
    evidence.request === null
      ? null
      : (() => {
          const url = redactDiagnosticUrl(evidence.request!.url, safeSecrets);
          const headers = redactDiagnosticHeaders(
            evidence.request!.headers,
            'request',
            safeSecrets,
          );
          const body = redactDiagnosticBody(evidence.request!.body, {
            secrets: safeSecrets,
            truncated: false,
          });
          return {
            method: cleanText(evidence.request!.method, 16),
            url: cleanText(url.text, 2_048),
            headers: headers.headers,
            body: body.body === null ? null : cleanText(body.body, MAX_BODY_CHARS),
            publicModelId: cleanText(evidence.request!.publicModelId, 128),
            upstreamModel: redactDiagnosticText(evidence.request!.upstreamModel, safeSecrets).text,
          };
        })();
  const redirects = evidence.redirects.slice(0, 20).map((redirect) => ({
    url: cleanText(redactDiagnosticUrl(redirect.url, safeSecrets).text, 2_048),
    method: cleanText(redirect.method, 16),
    status: redirect.status,
    strippedHeaders: redirect.strippedHeaders.slice(0, 32).map((name) => cleanText(name, 128)),
    ...(redirect.nextUrl === undefined
      ? {}
      : { nextUrl: cleanText(redactDiagnosticUrl(redirect.nextUrl, safeSecrets).text, 2_048) }),
  }));
  let response = null as ProbeEvidence['response'];
  if (evidence.response !== null) {
    const url = redactDiagnosticUrl(evidence.response.url, safeSecrets);
    const headers = redactDiagnosticHeaders(evidence.response.headers, 'response', safeSecrets);
    const body = redactDiagnosticBody(evidence.response.body, {
      secrets: safeSecrets,
      truncated: evidence.response.truncated || !evidence.response.complete,
    });
    response = {
      status: evidence.response.status,
      url: cleanText(url.text, 2_048),
      headers: headers.headers,
      body: body.body ?? '',
      format: evidence.response.format,
      capturedBytes: Math.min(evidence.response.capturedBytes, MAX_BODY_CHARS),
      complete: evidence.response.complete && !body.truncated,
      truncated: evidence.response.truncated || body.truncated,
      redacted: evidence.response.redacted || url.redacted || headers.redacted || body.redacted,
    };
  }
  const failure =
    evidence.failure === null
      ? null
      : (() => {
          const safe = redactDiagnosticError(
            { code: evidence.failure!.code, message: evidence.failure!.message },
            safeSecrets,
          );
          return {
            source: evidence.failure!.source,
            phase: evidence.failure!.phase,
            code: safe.code === null ? null : cleanText(safe.code, 128),
            message: cleanText(safe.message, 8_192),
            issues: evidence.failure!.issues.slice(0, 64).map((issue) => ({
              path: cleanText(issue.path, 512),
              message: cleanText(issue.message, 2_048),
            })),
          };
        })();

  return {
    requestId: cleanText(evidence.requestId, 128),
    startedAt: evidence.startedAt,
    durationMs: evidence.durationMs,
    execution: evidence.execution,
    request,
    redirects,
    response,
    failure,
    phases: evidence.phases.slice(0, 16).map((phase) => ({
      name: cleanText(phase.name, 64),
      durationMs: phase.durationMs,
      state: phase.state,
    })),
  };
}
