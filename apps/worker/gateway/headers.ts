import type { Protocol } from '@sub2api/apicompat/types/shared';

export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
export type UpstreamHeaderFailure = 'invalid_configuration';
export class UpstreamHeaderError extends Error {
  constructor(readonly reason: UpstreamHeaderFailure, options?: ErrorOptions) { super(`Cannot build upstream headers: ${reason}`, options); this.name = 'UpstreamHeaderError'; }
}
export interface UpstreamHeaderOptions {
  upstreamProtocol: Protocol;
  /** Channel credential, which may itself belong to another CheapAI instance. */
  upstreamKey: string;
  stream?: boolean;
  downstreamHeaders?: Headers;
  messages?: { version?: string };
  /** Trusted provider headers. Protocol authentication still comes from upstreamKey. */
  customHeaders?: Readonly<Record<string, string>>;
}

const transportHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
  // The gateway serializes a new plain JSON body, so source encoding/checksums
  // cannot describe the upstream representation. Provider extensions still pass.
  'content-encoding', 'content-md5', 'digest', 'content-digest', 'repr-digest',
]);
const clientCredentials = new Set(['authorization', 'x-api-key', 'cookie', 'x-csrf-token']);

/** Forward provider extensions, excluding platform credentials and HTTP framing.
 * Authentication has already happened at the gateway boundary; only the channel
 * credential is used for the upstream request.
 */
export function buildUpstreamHeaders(options: UpstreamHeaderOptions): Headers {
  const incoming = options.downstreamHeaders ?? new Headers();
  const hopNames = new Set((incoming.get('connection') ?? '').split(',').map(name => name.trim().toLowerCase()));
  const output = new Headers();
  for (const [name, value] of incoming) {
    if (transportHeaders.has(name) || clientCredentials.has(name) || hopNames.has(name)
        || name.startsWith('cf-') || name.startsWith('x-forwarded-') || name === 'forwarded'
        || name === 'origin' || name === 'referer') continue;
    output.set(name, value);
  }
  try {
    for (const [name, value] of Object.entries(options.customHeaders ?? {})) {
      if (transportHeaders.has(name.toLowerCase()) || name.toLowerCase() === 'authorization' || name.toLowerCase() === 'x-api-key') continue;
      output.set(name, value);
    }
    output.set('Content-Type', 'application/json');
    output.set('Accept', options.stream ? 'text/event-stream' : 'application/json');
    if (!options.upstreamKey) throw new Error('Missing upstream key');
    if (options.upstreamProtocol === 'messages') {
      output.set('x-api-key', options.upstreamKey);
      output.set('anthropic-version', options.messages?.version ?? output.get('anthropic-version') ?? DEFAULT_ANTHROPIC_VERSION);
    } else output.set('Authorization', `Bearer ${options.upstreamKey}`);
  } catch (cause) {
    // Headers enforces actual HTTP field syntax, including newline rejection.
    throw new UpstreamHeaderError('invalid_configuration', { cause });
  }
  return output;
}
