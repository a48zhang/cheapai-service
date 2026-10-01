import type { Protocol } from '@sub2api/apicompat/types/shared';

export type UpstreamUrlErrorCode = 'invalid_url' | 'https_required' | 'credentials_forbidden' |
  'query_or_fragment_forbidden' | 'unsafe_host' | 'invalid_path' | 'unsupported_protocol';

export class UpstreamUrlError extends Error {
  constructor(public readonly code: UpstreamUrlErrorCode) {
    super(`Invalid upstream URL configuration: ${code}.`);
    this.name = 'UpstreamUrlError';
  }
}

// Conservative exclusions, including globally reachable special-purpose blocks.
// Source: https://www.iana.org/assignments/iana-ipv4-special-registry/
const excludedV4: readonly [number, number][] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc01fc400, 24], [0xc034c100, 24], [0xc0586300, 24], [0xc0a80000, 16],
  [0xc0af3000, 24], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
  [0xe0000000, 3], // multicast and reserved/broadcast space
];

function unsafeIp(hostname: string): boolean {
  if (hostname.startsWith('[')) {
    // WHATWG URL has already validated and canonicalized the IPv6 literal.
    const parts = hostname.slice(1, -1).split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const groups = parts.length === 1 ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
    const value = groups.reduce((acc, group) => (acc << 16n) | BigInt(`0x${group}`), 0n);
    const inPrefix = (prefix: bigint, bits: number): boolean => value >> BigInt(128 - bits) === prefix >> BigInt(128 - bits);
    // Only ordinary global unicast. This also rejects mapped/compatible IPv4,
    // NAT64, unspecified, loopback, ULA, link/site-local and multicast literals.
    // Source: https://www.iana.org/assignments/iana-ipv6-special-registry/
    return !inPrefix(0x20000000000000000000000000000000n, 3) ||
      inPrefix(0x20010000000000000000000000000000n, 23) ||
      inPrefix(0x20010db8000000000000000000000000n, 32) ||
      inPrefix(0x20020000000000000000000000000000n, 16) ||
      inPrefix(0x2620004f800000000000000000000000n, 48) ||
      inPrefix(0x3fff0000000000000000000000000000n, 20);
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  const value = hostname.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
  return excludedV4.some(([prefix, bits]) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(prefix / 2 ** (32 - bits)));
}

/** Validates administrator configuration only; performs no DNS resolution.
 * Domain resolution/rebinding and redirect policy must be enforced by the caller's
 * network layer. A passing hostname is not proof that its resolved IP is public.
 */
export function validateUpstreamBaseUrl(input: string): URL {
  if (typeof input !== 'string' || /[\s\\]/u.test(input)) throw new UpstreamUrlError('invalid_url');
  let url: URL;
  try { url = new URL(input); } catch { throw new UpstreamUrlError('invalid_url'); }
  if (url.protocol !== 'https:') throw new UpstreamUrlError('https_required');
  const raw = /^https:\/\/([^/?#]+)([^?#]*)/i.exec(input);
  if (!raw) throw new UpstreamUrlError('invalid_url');
  if (url.username || url.password || raw[1]?.includes('@')) throw new UpstreamUrlError('credentials_forbidden');
  if (input.includes('?') || input.includes('#')) throw new UpstreamUrlError('query_or_fragment_forbidden');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const localSuffixes = ['localhost', 'local', 'internal', 'home.arpa'];
  if (!hostname || (!hostname.includes('.') && !hostname.startsWith('[')) ||
      localSuffixes.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`)) || unsafeIp(hostname)) {
    throw new UpstreamUrlError('unsafe_host');
  }
  if (!hostname.startsWith('[') && !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new UpstreamUrlError('unsafe_host');
  }
  // Reject ambiguous separators and traversal, rather than silently collapsing
  // double slashes or allowing URL parsing to erase a provider path prefix.
  const path = raw[2] ?? '';
  if (path.includes('//')) throw new UpstreamUrlError('invalid_path');
  for (const segment of path.split('/')) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { throw new UpstreamUrlError('invalid_path'); }
    if (decoded === '.' || decoded === '..' || /[\/\\%?#\u0000-\u0020\u007f]/.test(decoded)) {
      throw new UpstreamUrlError('invalid_path');
    }
  }
  url.hostname = hostname;
  // Normalize escaped unreserved characters (including an escaped v1 suffix).
  url.pathname = url.pathname.replace(/%([\da-f]{2})/gi, (encoded, hex: string) => {
    const character = String.fromCharCode(parseInt(hex, 16));
    return /^[A-Za-z0-9._~-]$/.test(character) ? character : encoded.toUpperCase();
  });
  return url;
}

/** Fixed protocol endpoints: never accepts a client URL, path or Authorization. */
export function buildUpstreamUrl(baseUrl: string, protocol: Protocol): URL {
  const endpoints: Record<Protocol, string> = { chat: 'chat/completions', responses: 'responses', messages: 'messages' };
  if (!Object.hasOwn(endpoints, protocol)) throw new UpstreamUrlError('unsupported_protocol');
  const url = validateUpstreamBaseUrl(baseUrl);
  const prefix = url.pathname.replace(/\/$/, '');
  url.pathname = `${prefix}${prefix.endsWith('/v1') ? '' : '/v1'}/${endpoints[protocol]}`;
  return url;
}
