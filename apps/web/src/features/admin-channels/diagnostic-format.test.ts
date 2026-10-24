import { describe, expect, it } from 'vitest';

import type { ChannelProbeResult } from '@cheapai/api-client/channels';
import {
  createDiagnosticPreview,
  formatDiagnosticCurl,
  formatDiagnosticExport,
  formatDiagnosticHeaders,
  formatDiagnosticResponseBody,
} from './diagnostic-format';
import {
  diagnosticModelA,
  makeChannel,
  makeProbeEvidence,
  makeProbeResult,
} from './diagnostic-test-fixtures';

const environmentMarker = '<CHEAPAI_UPSTREAM_KEY environment value>';

/** Parses the generated shell preview without starting a shell or expanding environment values. */
function parsePreviewArguments(command: string): string[] {
  const arguments_: string[] = [];
  let word = '';
  let wordStarted = false;
  let quote: 'single' | 'double' | null = null;

  const pushWord = () => {
    if (!wordStarted) return;
    arguments_.push(word);
    word = '';
    wordStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index);

    if (quote === 'single') {
      if (character === "'") quote = null;
      else word += character;
      continue;
    }

    if (quote === 'double') {
      if (command.startsWith('${CHEAPAI_UPSTREAM_KEY}', index)) {
        word += environmentMarker;
        index += '${CHEAPAI_UPSTREAM_KEY}'.length - 1;
      } else if (character === '"') {
        quote = null;
      } else if (character === '\\' && index + 1 < command.length) {
        const next = command[index + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          word += next;
          index += 1;
        } else {
          word += character;
        }
      } else {
        word += character;
      }
      continue;
    }

    if (character === "'") {
      quote = 'single';
      wordStarted = true;
    } else if (character === '"') {
      quote = 'double';
      wordStarted = true;
    } else if (character === '\\' && index + 1 < command.length) {
      const next = command.charAt(index + 1);
      if (next !== '\n') {
        word += next;
        wordStarted = true;
      }
      index += 1;
    } else if (/\s/u.test(character)) {
      pushWord();
    } else {
      if (character === '`' || command.startsWith('$(', index)) {
        throw new Error('Unexpected shell evaluation syntax in a quoted cURL preview.');
      }
      word += character;
      wordStarted = true;
    }
  }

  if (quote !== null) throw new Error('Unclosed quote in generated cURL preview.');
  pushWord();
  return arguments_;
}

describe('diagnostic formatting', () => {
  it('redacts query values from both displayed preview URLs', () => {
    const secret = 'PRIVATE_QUERY_SECRET_SENTINEL';
    const channel = makeChannel({
      baseUrl: `https://upstream.example/v1?api_key=${secret}&tenant=private-tenant`,
    });
    const preview = createDiagnosticPreview(channel, diagnosticModelA);

    expect(preview.url).not.toBeNull();
    expect(preview.baseUrl).not.toContain(secret);
    expect(preview.url).not.toContain(secret);
    expect([...new URL(preview.baseUrl).searchParams.values()]).toEqual([
      '[REDACTED]',
      '[REDACTED]',
    ]);
    expect([...new URL(preview.url ?? '').searchParams.values()]).toEqual([
      '[REDACTED]',
      '[REDACTED]',
    ]);
  });

  it('formats only complete JSON responses and preserves text, fragments, and truncation verbatim', () => {
    const complete = {
      body: '{"error":{"code":"model_not_found"}}',
      format: 'json' as const,
      complete: true,
      truncated: false,
    };
    const html = '<html><body>upstream failure</body></html>';
    const fragment = '{"error":{"message":"part';

    const formatted = formatDiagnosticResponseBody(complete);
    expect(JSON.parse(formatted)).toEqual({ error: { code: 'model_not_found' } });
    expect(
      formatDiagnosticResponseBody({
        body: html,
        format: 'text',
        complete: true,
        truncated: false,
      }),
    ).toBe(html);
    expect(
      formatDiagnosticResponseBody({
        body: fragment,
        format: 'fragment',
        complete: false,
        truncated: false,
      }),
    ).toBe(fragment);
    expect(
      formatDiagnosticResponseBody({
        body: fragment,
        format: 'json',
        complete: false,
        truncated: true,
      }),
    ).toBe(fragment);
    expect(formatDiagnosticResponseBody(null)).toBe('');
  });

  it('masks credential headers while retaining useful safe header values', () => {
    const headers = JSON.parse(
      formatDiagnosticHeaders({
        Authorization: 'Bearer PRIVATE_AUTH_SENTINEL',
        'X-Api-Key': 'PRIVATE_KEY_SENTINEL',
        Cookie: 'PRIVATE_COOKIE_SENTINEL',
        'Content-Type': 'application/json',
      }),
    ) as Record<string, string>;

    expect(headers).toEqual({
      Authorization: '[REDACTED]',
      'X-Api-Key': '[REDACTED]',
      Cookie: '[REDACTED]',
      'Content-Type': 'application/json',
    });
    expect(JSON.stringify(headers)).not.toContain('PRIVATE_');
    expect(formatDiagnosticHeaders(null)).toBe('');
  });

  it('quotes each cURL argument as a POSIX shell word without exposing credentials or following redirects', () => {
    const privateKey = 'PRIVATE_CURL_KEY_SENTINEL';
    const url = "https://upstream.example/v1/chat/completions?q=one two&label=it's-safe;$(echo no)";
    const body = JSON.stringify({ prompt: "say it's safe; $(touch /tmp/not-run)" });
    const customHeader = "X-Test: two words; $(echo no) and it's literal";
    const request = makeProbeEvidence({
      request: {
        method: 'POST',
        url,
        headers: {
          Authorization: `Bearer ${privateKey}`,
          'Content-Type': 'application/json',
          Cookie: 'PRIVATE_COOKIE_SENTINEL',
          'X-Test': customHeader.slice('X-Test: '.length),
        },
        body,
        publicModelId: diagnosticModelA.publicModelId,
        upstreamModel: diagnosticModelA.upstreamModel,
      },
    }).request;

    const command = formatDiagnosticCurl(request);
    expect(command).not.toBeNull();
    expect(command).not.toContain(privateKey);
    const arguments_ = parsePreviewArguments(command ?? '');
    const argumentAfter = (flag: string) => arguments_[arguments_.indexOf(flag) + 1];
    const headerArguments = arguments_.flatMap((argument, index) =>
      argument === '--header' ? [arguments_[index + 1]] : [],
    );

    expect(arguments_[0]).toBe('curl');
    expect(argumentAfter('--request')).toBe('POST');
    expect(argumentAfter('--url')).toBe(url);
    expect(argumentAfter('--data-raw')).toBe(body);
    expect(headerArguments).toContain(`Authorization: Bearer ${environmentMarker}`);
    expect(headerArguments).toContain(customHeader);
    expect(headerArguments).toContain('Cookie: [REDACTED]');
    expect(arguments_).not.toContain('--location');
    expect(arguments_).not.toContain('--location-trusted');
    expect(formatDiagnosticCurl(null)).toBeNull();
  });

  it('exports only reviewed result and API error fields, including controlled partial evidence', () => {
    const internalCause = 'PRIVATE_INTERNAL_CAUSE_SENTINEL';
    const result = {
      ...makeProbeResult(),
      exceptionStack: internalCause,
    } as ChannelProbeResult;
    const apiErrorWithInternal = {
      status: 503,
      code: 'service_unavailable',
      message: internalCause,
    };
    const resultExport = JSON.parse(
      formatDiagnosticExport({
        result,
        apiError: apiErrorWithInternal,
      }),
    ) as Record<string, unknown>;
    const partialExport = JSON.parse(
      formatDiagnosticExport({
        result: null,
        partialEvidence: makeProbeEvidence({
          execution: 'not_started',
          request: null,
          response: null,
          failure: {
            source: 'cheapai',
            phase: 'configuration',
            code: 'version_conflict',
            message: 'The channel configuration changed.',
            issues: [],
          },
        }),
        partialDiagnosticId: 'diag-partial-fixture',
        apiError: { status: 409, code: 'conflict' },
      }),
    ) as Record<string, unknown>;

    expect(resultExport).not.toHaveProperty('exceptionStack');
    expect(resultExport.apiError).toEqual({ status: 503, code: 'service_unavailable' });
    expect(JSON.stringify(resultExport)).not.toContain(internalCause);
    expect(partialExport.diagnosticId).toBe('diag-partial-fixture');
    expect(partialExport.upstreamStatus).toBeNull();
    expect(partialExport.apiError).toEqual({ status: 409, code: 'conflict' });
    expect(partialExport.evidence).toMatchObject({
      execution: 'not_started',
      failure: { code: 'version_conflict' },
    });
  });
});
