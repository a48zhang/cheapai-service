import { describe, expect, it } from 'vitest';
import { buildUpstreamUrl, UpstreamUrlError, validateUpstreamBaseUrl } from '../../apps/worker/gateway/upstream-url';

describe('administrator upstream URL configuration', () => {
  it.each([
    ['chat', 'chat/completions'], ['responses', 'responses'], ['messages', 'messages'],
  ] as const)('constructs the %s endpoint without duplicating v1', (protocol, endpoint) => {
    for (const base of ['https://api.example.com', 'https://api.example.com/', 'https://api.example.com/v1', 'https://api.example.com/v1/']) {
      expect(buildUpstreamUrl(base, protocol).href).toBe(`https://api.example.com/v1/${endpoint}`);
    }
  });

  it.each([
    ['http://localhost:8080/provider/v1/?api-version=preview', 'http://localhost:8080/provider/v1/messages?api-version=preview'],
    ['http://192.168.1.10:8443/provider', 'http://192.168.1.10:8443/provider/v1/messages'],
    ['http://[::1]:8080', 'http://[::1]:8080/v1/messages'],
    ['https://api.internal/provider/%76%31', 'https://api.internal/provider/%76%31/messages'],
    ['https://api.example.com/provider/v10', 'https://api.example.com/provider/v10/v1/messages'],
    ['https://api.example.com/v1/provider', 'https://api.example.com/v1/provider/v1/messages'],
    ['https://api.example.com/prefix//custom%2Fpath?key=test#fragment', 'https://api.example.com/prefix//custom%2Fpath/v1/messages?key=test'],
  ])('preserves provider paths and query parameters: %s', (base, expected) => {
    expect(buildUpstreamUrl(base, 'messages').href).toBe(expected);
  });

  it.each(['', '/relative', 'ftp://api.example.com', 'https://user:password@api.example.com', 'http://[broken'])
    ('rejects targets that HTTP fetch cannot use: %s', (base) => {
      expect(() => validateUpstreamBaseUrl(base)).toThrow(UpstreamUrlError);
    });
});
