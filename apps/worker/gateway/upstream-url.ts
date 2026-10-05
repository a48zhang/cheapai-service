import type { Protocol } from '@sub2api/apicompat/types/shared';

export type UpstreamUrlErrorCode = 'invalid_url' | 'unsupported_scheme' | 'credentials_forbidden' | 'unsupported_protocol';

export class UpstreamUrlError extends Error {
  constructor(public readonly code: UpstreamUrlErrorCode) {
    super(`Invalid upstream URL configuration: ${code}.`);
    this.name = 'UpstreamUrlError';
  }
}

/** Administrator-provided HTTP endpoint; network reachability belongs to fetch. */
export function validateUpstreamBaseUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new UpstreamUrlError('invalid_url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UpstreamUrlError('unsupported_scheme');
  // Fetch does not support URLs containing credentials. Channel keys supply auth.
  if (url.username || url.password) throw new UpstreamUrlError('credentials_forbidden');
  // Fragments are not sent in HTTP requests.
  url.hash = '';
  return url;
}

/** Append the protocol endpoint while retaining the provider prefix and query. */
export function buildUpstreamUrl(baseUrl: string, protocol: Protocol): URL {
  const endpoints: Record<Protocol, string> = { chat: 'chat/completions', responses: 'responses', messages: 'messages' };
  if (!Object.hasOwn(endpoints, protocol)) throw new UpstreamUrlError('unsupported_protocol');
  const url = validateUpstreamBaseUrl(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, '');
  const lastSegment = prefix.slice(prefix.lastIndexOf('/') + 1).replace(/%([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  url.pathname = `${prefix}${lastSegment === 'v1' ? '' : '/v1'}/${endpoints[protocol]}`;
  return url;
}
