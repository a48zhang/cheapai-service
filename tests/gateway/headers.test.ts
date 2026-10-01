import { describe, expect, it } from 'vitest';
import { buildUpstreamHeaders, DEFAULT_ANTHROPIC_VERSION, UpstreamHeaderError } from '../../apps/worker/gateway/headers';
import { generateToken } from '../../apps/worker/auth/tokens';

describe('trusted upstream header construction', () => {
  it('rebuilds protocol authentication and strips all ordinary downstream/hop-by-hop headers', () => {
    const token = generateToken('apiKey');
    const downstream = new Headers({ Authorization: `Bearer ${token}`, 'x-api-key': token, Cookie: 'secret-cookie', Host: 'attacker.example',
      'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-For': '5.6.7.8', Connection: 'x-private, authorization', 'x-private': 'secret',
      'Proxy-Authorization': 'secret', 'Transfer-Encoding': 'chunked', TE: 'trailers', Upgrade: 'websocket', 'Keep-Alive': 'timeout=5',
      'Content-Length': '999', 'anthropic-version': 'invalid', 'User-Agent': token, 'openai-project': 'attacker-project' });
    for (const upstreamProtocol of ['chat', 'responses'] as const) {
      const headers = buildUpstreamHeaders({ upstreamProtocol, upstreamKey: 'trusted-upstream-key', downstreamHeaders: downstream });
      expect(Object.fromEntries(headers)).toEqual({ accept: 'application/json', authorization: 'Bearer trusted-upstream-key', 'content-type': 'application/json' });
      expect(JSON.stringify(Object.fromEntries(headers))).not.toContain(token);
    }
    const headers = buildUpstreamHeaders({ upstreamProtocol: 'messages', upstreamKey: 'trusted-upstream-key', downstreamHeaders: downstream, stream: true });
    expect(Object.fromEntries(headers)).toEqual({ accept: 'text/event-stream', 'content-type': 'application/json', 'x-api-key': 'trusted-upstream-key', 'anthropic-version': DEFAULT_ANTHROPIC_VERSION });
    expect(downstream.get('Cookie')).toBe('secret-cookie');
  });
  it('rejects conflicting or malformed platform authentication even though it never forwards it', () => {
    const token = generateToken('apiKey');
    expect(() => buildUpstreamHeaders({ upstreamProtocol: 'chat', upstreamKey: 'upstream', downstreamHeaders: new Headers({ Authorization: `Bearer ${token}`, 'x-api-key': generateToken('apiKey') }) })).toThrow(UpstreamHeaderError);
    for (const authorization of ['Basic secret', 'Bearer bad', `Bearer ${token}, Bearer ${token}`]) expect(() => buildUpstreamHeaders({ upstreamProtocol: 'chat', upstreamKey: 'upstream', downstreamHeaders: new Headers({ Authorization: authorization }) })).toThrow();
  });
  it('allows only explicitly negotiated Messages betas and never transfers them to Chat/Responses', () => {
    const incoming = new Headers({ 'anthropic-beta': 'feature-2026-01-01,feature-2026-01-01' });
    expect(() => buildUpstreamHeaders({ upstreamProtocol: 'messages', upstreamKey: 'upstream', downstreamHeaders: incoming })).toThrow();
    const policy = { allowedBetas: ['feature-2026-01-01'] };
    expect(buildUpstreamHeaders({ upstreamProtocol: 'messages', upstreamKey: 'upstream', downstreamHeaders: incoming, messages: policy }).get('anthropic-beta')).toBe('feature-2026-01-01');
    expect(buildUpstreamHeaders({ upstreamProtocol: 'chat', upstreamKey: 'upstream', downstreamHeaders: incoming }).has('anthropic-beta')).toBe(false);
    incoming.set('Connection', 'anthropic-beta');
    expect(buildUpstreamHeaders({ upstreamProtocol: 'messages', upstreamKey: 'upstream', downstreamHeaders: incoming, messages: policy }).has('anthropic-beta')).toBe(false);
    expect(() => buildUpstreamHeaders({ upstreamProtocol: 'messages', upstreamKey: 'upstream', messages: { version: '9999-01-01' } })).toThrow();
  });
  it('restricts trusted custom headers and rejects invalid/accidental platform upstream secrets', () => {
    expect(buildUpstreamHeaders({ upstreamProtocol: 'responses', upstreamKey: 'upstream', customHeaders: { 'OpenAI-Project': 'proj_123' } }).get('openai-project')).toBe('proj_123');
    for (const name of ['Authorization', 'Cookie', 'Host', 'Connection', 'x-api-key', 'CF-Access-Client-Secret']) expect(() => buildUpstreamHeaders({ upstreamProtocol: 'chat', upstreamKey: 'upstream', customHeaders: { [name]: 'value' } })).toThrow();
    for (const upstreamKey of ['', 'with space', 'bad\r\nheader', generateToken('apiKey')]) expect(() => buildUpstreamHeaders({ upstreamProtocol: 'chat', upstreamKey })).toThrow();
  });
  it('rejects all surrounding whitespace before Headers can normalize trusted credentials or tenant values', () => {
    for (const value of ['secret\n', 'secret\r\n', ' secret', 'secret ', '\tsecret', 'secret\t', '\u00a0secret', 'secret\u00a0']) {
      expect(() => buildUpstreamHeaders({ upstreamProtocol: 'chat', upstreamKey: value })).toThrow(UpstreamHeaderError);
      expect(() => buildUpstreamHeaders({ upstreamProtocol: 'chat', upstreamKey: 'upstream', customHeaders: { 'OpenAI-Project': value } })).toThrow(UpstreamHeaderError);
    }
  });
  it('rejects Connection-nominated tenant headers without silently changing configured tenants', () => {
    for (const name of ['OpenAI-Project', 'OpenAI-Organization']) {
      expect(() => buildUpstreamHeaders({ upstreamProtocol: 'responses', upstreamKey: 'upstream',
        downstreamHeaders: new Headers({ Connection: `${name.toUpperCase()}, keep-alive` }), customHeaders: { [name]: 'tenant_123' } }))
        .toThrow('invalid_downstream_headers');
    }
    for (const connection of ['bad header', 'keep-alive,,upgrade', '"openai-project"']) {
      expect(() => buildUpstreamHeaders({ upstreamProtocol: 'chat', upstreamKey: 'upstream', downstreamHeaders: new Headers({ Connection: connection }) })).toThrow('invalid_downstream_headers');
    }
    expect(buildUpstreamHeaders({ upstreamProtocol: 'chat', upstreamKey: 'upstream', downstreamHeaders: new Headers({ Connection: 'authorization, content-type' }) }).get('Authorization')).toBe('Bearer upstream');
  });
  it('does not silently replace malformed trusted Messages policies with defaults', () => {
    for (const messages of [null, { version: null }, { allowedBetas: null }, { supported: true }, { allowedBetas: ['beta\n'] }]) {
      expect(() => buildUpstreamHeaders({ upstreamProtocol: 'messages', upstreamKey: 'upstream', messages: messages as never })).toThrow(UpstreamHeaderError);
    }
  });
});
