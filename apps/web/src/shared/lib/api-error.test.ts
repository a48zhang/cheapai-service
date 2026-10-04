import { expect, it } from 'vitest';
import { ApiClientError } from '@cheapai/api-client/errors';
import { withErrorContext } from './api-error';

it('retains transport classification and request diagnostics when adding form context', () => {
  const original = new ApiClientError('api', 'original', {
    status: 409,
    code: 'conflict',
    request_id: 'req-1',
  });
  const contextual = withErrorContext(original, 'context');
  expect(contextual).toBeInstanceOf(ApiClientError);
  expect(contextual).toMatchObject({
    kind: original.kind,
    status: original.status,
    code: original.code,
    request_id: original.request_id,
  });
  expect(contextual.cause).toBe(original);
  const local = new TypeError();
  expect(withErrorContext(local, 'context').cause).toBe(local);
});
