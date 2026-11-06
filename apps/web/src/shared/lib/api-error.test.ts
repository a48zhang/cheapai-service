import { describe, expect, it } from 'vitest';
import { ApiClientError } from '@cheapai/api-client/errors';
import { errorDetails, withErrorContext } from './api-error';

describe('shared error diagnostics', () => {
  it('keeps operation context, received diagnostics and the original cause together', () => {
    const original = new ApiClientError('api', 'Provider rejected size (HTTP 422)', {
      status: 422,
      code: 'unsupported_size',
      request_id: 'request-1',
      details: { size: '1024x768' },
      cause: new Error('provider response'),
    });
    const text = errorDetails(withErrorContext(original, '生成失败，请调整尺寸。'));
    for (const value of [
      '生成失败',
      'Provider rejected size',
      '422',
      'unsupported_size',
      'request-1',
      '1024x768',
      'provider response',
    ])
      expect(text).toContain(value);
  });
  it('preserves diagnostics without a request ID and terminates cyclic causes', () => {
    const error = new ApiClientError('http', 'Proxy rejected request', { status: 502 });
    error.cause = error;
    expect(errorDetails(error)).toBe(
      '具体原因：Proxy rejected request\nHTTP 状态：502\n错误码：http',
    );
  });
});
