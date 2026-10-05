import { describe, expect, it } from 'vitest';
import { buildUpstreamHeaders, DEFAULT_ANTHROPIC_VERSION, UpstreamHeaderError } from '../../apps/worker/gateway/headers';
import { generateToken } from '../../apps/worker/auth/tokens';

describe('upstream header construction', () => {
  it('forwards provider extensions while replacing credentials and removing hop-by-hop and stale body metadata', () => {
    const token = generateToken('apiKey');
    const downstream = new Headers({ Authorization: `Bearer ${token}`, 'x-api-key': token, Cookie: 'session=secret', Host: 'client.example',
      'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-For': '5.6.7.8', Connection: 'x-private, authorization', 'x-private': 'secret',
      'Proxy-Authorization': 'secret', 'Transfer-Encoding': 'chunked', TE: 'trailers', Upgrade: 'websocket', 'Keep-Alive': 'timeout=5',
      'Content-Length': '999', 'Content-Encoding': 'gzip', 'Content-MD5': 'original-checksum',
      Digest: 'sha-256=original', 'Content-Digest': 'sha-256=:original:', 'Repr-Digest': 'sha-256=:original:', 'x-provider-feature': 'preview', 'openai-project': 'tenant-project', 'x-csrf-token': 'platform-csrf' });
    for (const upstreamProtocol of ['chat', 'responses', 'messages'] as const) {
      const headers = buildUpstreamHeaders({ upstreamProtocol, upstreamKey: 'trusted-upstream-key', downstreamHeaders: downstream });
      expect(headers.get('x-provider-feature')).toBe('preview');
      expect(headers.get('openai-project')).toBe('tenant-project');
      expect(headers.get(upstreamProtocol === 'messages' ? 'x-api-key' : 'authorization'))
        .toBe(upstreamProtocol === 'messages' ? 'trusted-upstream-key' : 'Bearer trusted-upstream-key');
      for (const name of ['cookie', 'host', 'cf-connecting-ip', 'x-forwarded-for', 'connection', 'x-private', 'proxy-authorization', 'transfer-encoding', 'te', 'upgrade', 'keep-alive', 'content-length', 'content-encoding', 'content-md5', 'digest', 'content-digest', 'repr-digest', 'x-csrf-token']) expect(headers.has(name)).toBe(false);
      expect(JSON.stringify(Object.fromEntries(headers))).not.toContain(token);
    }
    expect(downstream.get('Cookie')).toBe('session=secret');
  });

  it('allows CheapAI chaining without revalidating already authenticated downstream tokens', () => {
    const upstreamKey = generateToken('apiKey');
    const headers = buildUpstreamHeaders({ upstreamProtocol: 'chat', upstreamKey,
      downstreamHeaders: new Headers({ Authorization: 'Bearer any-authenticated-platform-format', 'x-api-key': 'unused' }) });
    expect(headers.get('authorization')).toBe(`Bearer ${upstreamKey}`);
    expect(headers.has('x-api-key')).toBe(false);
  });

  it('forwards new Anthropic versions and beta values without a feature allowlist', () => {
    const incoming = new Headers({ 'anthropic-version': '2027-01-01', 'anthropic-beta': 'new-feature,custom-preview' });
    const headers = buildUpstreamHeaders({ upstreamProtocol: 'messages', upstreamKey: 'upstream', downstreamHeaders: incoming });
    expect(headers.get('anthropic-version')).toBe('2027-01-01');
    expect(headers.get('anthropic-beta')).toBe('new-feature,custom-preview');
    expect(buildUpstreamHeaders({ upstreamProtocol: 'messages', upstreamKey: 'upstream' }).get('anthropic-version')).toBe(DEFAULT_ANTHROPIC_VERSION);
    expect(buildUpstreamHeaders({ upstreamProtocol: 'messages', upstreamKey: 'upstream', downstreamHeaders: incoming,
      messages: { version: '2028-01-01' } }).get('anthropic-version')).toBe('2028-01-01');
    incoming.set('connection', 'anthropic-beta');
    expect(buildUpstreamHeaders({ upstreamProtocol: 'messages', upstreamKey: 'upstream', downstreamHeaders: incoming }).has('anthropic-beta')).toBe(false);
  });

  it('accepts arbitrary configured provider headers and normal header values', () => {
    const headers = buildUpstreamHeaders({ upstreamProtocol: 'messages', upstreamKey: 'upstream',
      customHeaders: { 'OpenAI-Project': 'project.example:preview', 'CF-Access-Client-Secret': 'access-secret', 'X-Custom-Feature': 'feature one', 'Content-Encoding': 'gzip', Authorization: 'ignored' } });
    expect(headers.get('openai-project')).toBe('project.example:preview');
    expect(headers.get('cf-access-client-secret')).toBe('access-secret');
    expect(headers.get('x-custom-feature')).toBe('feature one');
    expect(headers.has('content-encoding')).toBe(false);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.get('x-api-key')).toBe('upstream');
  });

  it('retains HTTP header syntax validation', () => {
    expect(() => buildUpstreamHeaders({ upstreamProtocol: 'chat', upstreamKey: 'bad\r\ninjected: header' })).toThrow(UpstreamHeaderError);
    expect(() => buildUpstreamHeaders({ upstreamProtocol: 'chat', upstreamKey: 'key', customHeaders: { 'invalid name': 'value' } })).toThrow(UpstreamHeaderError);
  });
});
