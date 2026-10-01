import { describe, expect, it } from 'vitest';
import type { Protocol } from '@sub2api/apicompat/types/shared';
import { buildUpstreamUrl, UpstreamUrlError, validateUpstreamBaseUrl } from '../../apps/worker/gateway/upstream-url';

describe('administrator upstream URL configuration', () => {
  it.each([
    ['chat', 'chat/completions'], ['responses', 'responses'], ['messages', 'messages'],
  ] as const)('constructs the fixed %s endpoint', (protocol, endpoint) => {
    for (const base of ['https://api.example.com', 'https://api.example.com/', 'https://api.example.com/v1', 'https://api.example.com/v1/']) {
      expect(buildUpstreamUrl(base, protocol).href).toBe(`https://api.example.com/v1/${endpoint}`);
    }
  });

  it.each([
    ['https://API.EXAMPLE.COM.:443/provider/v1/', 'https://api.example.com/provider/v1/messages'],
    ['https://api.example.com:8443/provider', 'https://api.example.com:8443/provider/v1/messages'],
    ['https://api.example.com/provider/%76%31', 'https://api.example.com/provider/v1/messages'],
    ['https://api.example.com/provider/v10', 'https://api.example.com/provider/v10/v1/messages'],
    ['https://api.example.com/v1/provider', 'https://api.example.com/v1/provider/v1/messages'],
  ])('preserves and normalizes the prefix: %s', (base, expected) => {
    expect(buildUpstreamUrl(base, 'messages').href).toBe(expected);
  });

  it.each(['8.8.8.8', '1.1.1.1', '[2606:4700:4700::1111]', '[2001:4860:4860::8888]'])
    ('accepts ordinary public literal %s without making a network request', (host) => {
      expect(validateUpstreamBaseUrl(`https://${host}`).hostname).toBe(host);
    });

  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.255', '192.0.0.9', '192.0.2.1', '192.31.196.1', '192.52.193.1',
    '192.88.99.1', '192.168.1.1', '192.175.48.1', '198.18.0.1', '198.19.255.255', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '2130706433', '0177.0.0.1', '0x7f000001', '127.1', '127.0.0.1.', '%31%32%37.0.0.1',
    '[::]', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:8.8.8.8]', '[::127.0.0.1]',
    '[64:ff9b::7f00:1]', '[100::1]', '[2001::1]', '[2001:db8::1]', '[2002:7f00:1::]',
    '[2620:4f:8000::1]', '[3fff::1]', '[fc00::1]', '[fd12::1]', '[fe80::1]', '[fec0::1]', '[ff02::1]',
    'localhost', 'LOCALHOST.', 'api.localhost', 'local', 'api.local', 'api.internal', 'home.arpa', 'api.home.arpa',
  ])('rejects unsafe or special host %s', (host) => {
    expect(() => validateUpstreamBaseUrl(`https://${host}`)).toThrow(UpstreamUrlError);
  });

  it.each([
    '', '/relative', 'http://api.example.com', 'ftp://api.example.com', 'https:api.example.com',
    'https:///api.example.com', 'https://user:password@api.example.com', 'https://@api.example.com',
    'https://api.example.com?key=secret', 'https://api.example.com?', 'https://api.example.com#',
    ' https://api.example.com', 'https://api.example.com\n', 'https://api.example.com\\prefix',
    'https://api.example.com//prefix', 'https://api.example.com/prefix//', 'https://api.example.com/a/../v1',
    'https://api.example.com/a/%2e%2e/v1', 'https://api.example.com/a/%2F/v1',
    'https://api.example.com/a/%5c/v1', 'https://api.example.com/a/%252f/v1',
    'https://api.example.com/a/%0a/v1', 'https://api.example.com/%broken', 'https://[fe80::1%25eth0]',
  ])('rejects invalid or ambiguous URL %#', (base) => {
    expect(() => buildUpstreamUrl(base, 'chat')).toThrow(UpstreamUrlError);
  });

  it('returns a typed error without including URL credentials', () => {
    try {
      validateUpstreamBaseUrl('https://user:private-key@api.example.com');
      throw new Error('Expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamUrlError);
      expect((error as UpstreamUrlError).code).toBe('credentials_forbidden');
      expect((error as Error).message).not.toContain('private-key');
    }
  });

  it('rejects runtime protocol overrides', () => {
    expect(() => buildUpstreamUrl('https://api.example.com', 'https://evil.example' as Protocol)).toThrow(UpstreamUrlError);
  });
});
