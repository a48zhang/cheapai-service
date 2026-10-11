import { createResponseIds } from '@sub2api/apicompat/ids';
import { parseChatResponse } from '@sub2api/apicompat/types/chat';
import { parseMessagesResponse } from '@sub2api/apicompat/types/messages';
import type { Protocol } from '@sub2api/apicompat/types/shared';
import { responsesResponseAdapter } from '@sub2api/apicompat/passthrough/responses';

export interface DiagnosticValidationIssue {
  path: string;
  message: string;
}

export type DiagnosticValidationKind =
  'valid' | 'content_type' | 'empty' | 'incomplete' | 'invalid_json' | 'invalid_protocol';

export interface DiagnosticValidationResult {
  valid: boolean;
  kind: DiagnosticValidationKind;
  issues: DiagnosticValidationIssue[];
}

export interface DiagnosticValidationInput {
  protocol: Protocol;
  contentType: string | null;
  bytes: Uint8Array;
  complete: boolean;
  truncated: boolean;
  diagnosticId: string;
  model: string;
}

function issue(path: string, message: string): DiagnosticValidationResult {
  return { valid: false, kind: 'invalid_protocol', issues: [{ path, message }] };
}

function parserIssue(param: string | undefined, message: string): DiagnosticValidationResult {
  const path =
    param === undefined || param.length === 0 ? '$' : param.startsWith('$') ? param : `$.${param}`;
  return issue(path, message);
}

function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
}

function invalid(
  kind: Exclude<DiagnosticValidationKind, 'valid' | 'invalid_protocol'>,
  path: string,
  message: string,
): DiagnosticValidationResult {
  return { valid: false, kind, issues: [{ path, message }] };
}

function jsonSyntaxMessage(error: unknown): string {
  if (!(error instanceof SyntaxError)) return 'The response body could not be parsed as JSON.';
  // Keep only numeric location data. Native parser messages can quote provider
  // body fragments, so their prose is never copied into diagnostic evidence.
  const source = error.message;
  const position = /\bposition\s+(\d+)\b/iu.exec(source)?.[1];
  if (position !== undefined) {
    const offset = Number(position);
    if (Number.isSafeInteger(offset) && offset >= 0 && offset <= 32_768) {
      return `The response body contains invalid JSON at offset ${offset}.`;
    }
  }
  const line = /\bline\s+(\d+)\b/iu.exec(source)?.[1];
  const column = /\bcolumn\s+(\d+)\b/iu.exec(source)?.[1];
  if (line !== undefined && column !== undefined) {
    const lineNumber = Number(line);
    const columnNumber = Number(column);
    if (
      Number.isSafeInteger(lineNumber) &&
      lineNumber > 0 &&
      Number.isSafeInteger(columnNumber) &&
      columnNumber > 0
    ) {
      return `The response body contains invalid JSON at line ${lineNumber}, column ${columnNumber}.`;
    }
  }
  return 'The response body could not be parsed as JSON.';
}

/** Validate only a complete, bounded JSON response with the existing protocol parsers. */
export function validateDiagnosticResponse(
  input: DiagnosticValidationInput,
): DiagnosticValidationResult {
  const { protocol, bytes, complete, truncated } = input;
  if (bytes.byteLength === 0 && complete && !truncated) {
    return invalid('empty', '$', 'The upstream response body is empty.');
  }
  if (!complete || truncated) {
    return invalid(
      'incomplete',
      '$',
      'The response body was incomplete; protocol validation could not finish.',
    );
  }
  if (!isJsonContentType(input.contentType)) {
    return invalid(
      'content_type',
      '$headers.content-type',
      'The upstream response Content-Type is not JSON.',
    );
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalid('invalid_json', '$', 'The response body is not valid UTF-8 JSON.');
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return invalid('invalid_json', '$', jsonSyntaxMessage(error));
  }

  if (protocol === 'chat') {
    const parsed = parseChatResponse(value, { unknownFields: 'preserve' });
    return parsed.ok
      ? { valid: true, kind: 'valid', issues: [] }
      : parserIssue(parsed.error.param, parsed.error.message);
  }
  if (protocol === 'messages') {
    const parsed = parseMessagesResponse(value, { unknownFields: 'preserve' });
    return parsed.ok
      ? { valid: true, kind: 'valid', issues: [] }
      : parserIssue(parsed.error.param, parsed.error.message);
  }

  // Responses has a single maintained response validator in the compatibility
  // adapter. Supply deterministic local IDs so validation has no random state.
  const seed = /^[A-Za-z0-9_-]{1,48}$/u.test(input.diagnosticId)
    ? input.diagnosticId
    : 'diagnostic_probe';
  const ids = createResponseIds({ seed });
  if (!ids.ok) return parserIssue(ids.error.param, ids.error.message);
  const parsed = responsesResponseAdapter.convert(value, {
    identity: ids.value.identity,
    idFor: ids.value.idFor,
    targetModel: input.model || 'diagnostic_model',
    createdAt: 0,
  });
  return parsed.ok
    ? { valid: true, kind: 'valid', issues: [] }
    : parserIssue(parsed.error.param, parsed.error.message);
}
