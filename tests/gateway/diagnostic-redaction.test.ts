import { describe, expect, it } from 'vitest';
import { generateToken } from '../../apps/worker/auth/tokens';
import {
  redactDiagnosticBody,
  redactDiagnosticError,
  redactDiagnosticHeaders,
  redactDiagnosticText,
  redactDiagnosticUrl,
} from '../../apps/worker/gateway/diagnostic-redaction';

describe('channel diagnostic redaction', () => {
  it('removes a generated channel key from URLs, headers, JSON, text, and error messages', () => {
    const key = generateToken('apiKey');
    const encodedKey = Array.from(
      new TextEncoder().encode(key),
      (byte) => `%${byte.toString(16).padStart(2, '0')}`,
    ).join('');

    const url = redactDiagnosticUrl(
      `https://user:${key}@provider.test/path/${encodedKey}?model=ok&api-token=${key}`,
      [key],
    );
    expect(url.text).not.toContain(key);
    expect(url.text).not.toContain(encodedKey);
    expect(url.text).toContain('model=ok');
    expect(url.redacted).toBe(true);

    const requestHeaders = redactDiagnosticHeaders(
      new Headers({
        Authorization: `Bearer ${key}`,
        'x-api-key': key,
        'content-type': 'application/json',
      }),
      'request',
      [key],
    );
    expect(requestHeaders.headers.authorization).toBe('[REDACTED]');
    expect(requestHeaders.headers['x-api-key']).toBe('[REDACTED]');
    expect(JSON.stringify(requestHeaders.headers)).not.toContain(key);

    const responseHeaders = redactDiagnosticHeaders(
      new Headers({
        'content-type': 'application/json',
        'x-request-id': 'provider-request-17',
        'retry-after': '3',
        'set-cookie': `session=${key}`,
        location: `https://provider.test/next?token=${key}`,
        'x-provider-private': key,
      }),
      'response',
      [key],
    );
    expect(responseHeaders.headers).toEqual({
      'content-type': 'application/json',
      'retry-after': '3',
      'x-request-id': 'provider-request-17',
    });
    expect(JSON.stringify(responseHeaders.headers)).not.toContain(key);

    const body = redactDiagnosticBody(
      JSON.stringify({
        error: {
          code: 'invalid_api_key',
          message: `Provider rejected ${key}; see https://provider.test/?token=${key}`,
        },
        api_key: key,
        metadata: { [`credential-${key}`]: 'reflected field name' },
        other: 'https://provider.test/?safe=1&api-token=hidden',
      }),
      { secrets: [key] },
    );
    expect(body.body).not.toContain(key);
    expect(body.body).not.toContain('credential-');
    expect(body.body).toContain('invalid_api_key');
    expect(body.body).toContain('Provider rejected');
    expect(body.body).toContain('safe=1');
    expect(body.redacted).toBe(true);

    const error = redactDiagnosticError({ code: 'provider_denied', message: `Rejected ${key}` }, [
      key,
    ]);
    expect(error).toEqual({ code: 'provider_denied', message: 'Rejected [REDACTED]' });
  });

  it('masks unknown sensitive assignments and a known key prefix at a captured tail', () => {
    const key = generateToken('apiKey');
    const auth = redactDiagnosticText('Authorization: Bearer UNKNOWN_PROVIDER_TOKEN');
    expect(auth.text).toBe('Authorization: [REDACTED]');

    const text = redactDiagnosticText(
      `provider error: ?token=visible&api-token=visible Authorization: Bearer ${key.slice(0, 10)}`,
      [key],
      { truncated: true },
    );
    expect(text.text).not.toContain('visible');
    expect(text.text).not.toContain(key.slice(0, 10));
    expect(text.text).toContain('provider error');

    const reflectedTail = redactDiagnosticText(`provider echoed ${key.slice(0, 12)}`, [key], {
      truncated: true,
    });
    expect(reflectedTail.text).not.toContain(key.slice(0, 12));
    expect(reflectedTail.text).toContain('provider echoed');

    const incompleteJson = redactDiagnosticBody(
      `{"error":{"code":"bad_key","api_key":"${key.slice(0, 14)}`,
      {
        secrets: [key],
        truncated: true,
      },
    );
    expect(incompleteJson.body).not.toContain(key.slice(0, 14));
    expect(incompleteJson.body).toContain('bad_key');

    const rawProviderError = redactDiagnosticBody(
      `{"error":{"code":"invalid_api_key","message":"Provider echoed ${key.slice(0, 13)}`,
      {
        secrets: [key],
        truncated: true,
      },
    );
    expect(rawProviderError.body).not.toContain(key.slice(0, 13));
    expect(rawProviderError.body).toContain('invalid_api_key');
  });
});
