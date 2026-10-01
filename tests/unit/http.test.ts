import { describe, expect, it } from 'vitest';
import { ApiError, apiError, apiSuccess, createRequestId, parsePagination } from '../../apps/worker/http';

describe('management API envelopes', () => {
  it('keeps exact signed amount strings and the supplied request ID', async () => {
    const data = { balance_units: '-900719925474099312345', price: '0.000001' };
    const response = apiSuccess(data, 'server-request-1');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ data, request_id: 'server-request-1' });
  });

  it.each([201, 202] as const)('supports a JSON success with status %i', async (status) => {
    const response = apiSuccess(null, 'request-2', status);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ data: null, request_id: 'request-2' });
  });

  it.each([
    ['invalid_request', 400], ['unauthorized', 401], ['insufficient_balance', 402],
    ['forbidden', 403], ['not_found', 404], ['conflict', 409],
    ['payload_too_large', 413], ['rate_limited', 429], ['internal_error', 500],
    ['service_unavailable', 503],
  ] as const)('maps %s to %i', async (code, status) => {
    const response = apiError(new ApiError(code), 'request-3');
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      error: { code, message: expect.any(String) }, request_id: 'request-3',
    });
  });

  it.each([
    new Error('password=secret', { cause: new Error('upstream API key') }),
    { code: 'forbidden', message: 'SELECT secret FROM users', stack: 'private stack' },
    'upstream response containing a token', null,
  ])('redacts unknown thrown values', async (error) => {
    const response = apiError(error, 'request-4');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: 'internal_error', message: 'Internal server error.' },
      request_id: 'request-4',
    });
  });

  it('uses allowlisted messages even when a typed error carries sensitive details', async () => {
    const error = new ApiError('service_unavailable');
    error.message = 'Authorization: Bearer secret';
    error.cause = { password: 'secret' };
    expect(await apiError(error, 'request-5').json()).toEqual({
      error: { code: 'service_unavailable', message: 'Service temporarily unavailable.' },
      request_id: 'request-5',
    });
  });

  it('generates independent UUID request IDs', () => {
    const id = createRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(createRequestId()).not.toBe(id);
  });
});

describe('cursor/limit pagination', () => {
  it('defaults to 20 items and no cursor', () => {
    expect(parsePagination(new URLSearchParams())).toEqual({ cursor: null, limit: 20 });
  });

  it.each([1, 20, 100])('accepts limit %i and preserves an opaque cursor', (limit) => {
    expect(parsePagination(new URLSearchParams({ limit: String(limit), cursor: 'YWJj_123-XYZ' })))
      .toEqual({ limit, cursor: 'YWJj_123-XYZ' });
  });

  it.each(['', '0', '-1', '101', '1000', '1.5', '1e2', 'NaN', 'Infinity', ' 20', '20 ', '+20', '020', '9007199254740993'])
    ('rejects invalid limit %j', (limit) => {
      expect(() => parsePagination(new URLSearchParams({ limit }))).toThrow(ApiError);
    });

  it.each(['', ' ', 'abc=', 'a+b', 'a/b', 'abc\n', '中文', 'x'.repeat(1025)])
    ('rejects malformed or oversized cursor %#', (cursor) => {
      expect(() => parsePagination(new URLSearchParams({ cursor }))).toThrow(ApiError);
    });

  it('accepts the cursor length boundary', () => {
    expect(parsePagination(new URLSearchParams({ cursor: 'x'.repeat(1024) })).cursor).toHaveLength(1024);
  });

  it.each(['limit=20&limit=30', 'cursor=abc&cursor=def'])('rejects duplicate parameters: %s', async (query) => {
    let error: unknown;
    try { parsePagination(new URLSearchParams(query)); } catch (caught) { error = caught; }
    const response = apiError(error, 'request-pagination');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'invalid_request', message: 'Invalid request.' },
      request_id: 'request-pagination',
    });
  });
});
