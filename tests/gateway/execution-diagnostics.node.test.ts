import { afterEach, expect, it, vi } from 'vitest';
import { captureProviderFailure, logExecutionFailure, requestDiagnosticSecrets } from '../../apps/worker/gateway/execution-diagnostics';
import { UpstreamTransportError } from '../../apps/worker/gateway/transport';

afterEach(() => vi.restoreAllMocks());
it('retains a concrete nested transport cause while redacting credentials and known request text', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const cause = new Error('connect ECONNRESET; credential=private-key; user text PRIVATE PROMPT');
  Object.assign(cause, { code: 'ECONNRESET' });
  logExecutionFailure({ id: 'request-1' }, { stage: 'stream_start', source: 'transport', code: 'network_error',
    cause: new UpstreamTransportError('network_error', 'uncertain', undefined, cause) },
  ['private-key', ...requestDiagnosticSecrets({ messages: [{ role: 'user', content: 'PRIVATE PROMPT' }] })]);
  const event = JSON.parse(log.mock.calls[0]![0]);
  expect(event.causes[1]).toMatchObject({ code: 'ECONNRESET', message: expect.stringContaining('connect ECONNRESET') });
  expect(JSON.stringify(event)).not.toMatch(/private-key|PRIVATE PROMPT/);
});
it('bounds HTTP error capture and records missing evidence rather than logging arbitrary non-JSON', async () => {
  const result = await captureProviderFailure(new Response('PRIVATE HTML RESPONSE'), () => {});
  expect(result).toEqual({ note: 'provider_error_body_not_json' });
});
it('retains bounded structured error fields without copying sibling payloads', async () => {
  const result = await captureProviderFailure(Response.json({ error: { code: 'quota_exhausted', type: 'billing_error', message: 'No remaining provider credits' }, content: 'PRIVATE ANSWER' }), () => {});
  expect(result).toMatchObject({ provider: { code: 'quota_exhausted', message: 'No remaining provider credits' } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE ANSWER');
});
