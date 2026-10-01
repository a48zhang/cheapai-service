import type { Protocol } from '@sub2api/apicompat/types/shared';
import { getTokenDisplayPrefix } from '../auth/tokens';

export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
export type UpstreamHeaderFailure = 'invalid_configuration' | 'invalid_downstream_auth' | 'conflicting_downstream_auth' | 'invalid_downstream_headers' | 'unsupported_beta';
export class UpstreamHeaderError extends Error {
  constructor(readonly reason: UpstreamHeaderFailure) { super(`Cannot build upstream headers: ${reason}`); this.name = 'UpstreamHeaderError'; }
}
export interface UpstreamHeaderOptions {
  upstreamProtocol: Protocol;
  /** Trusted decrypted channel secret, not a platform credential/header value. */
  upstreamKey: string;
  stream?: boolean;
  downstreamHeaders?: Headers;
  /** Trusted per-channel/model policy, not copied from request JSON or headers. */
  messages?: { version?: string; allowedBetas?: readonly string[] };
  /** Trusted OpenAI-compatible tenant selection only; no arbitrary header names. */
  customHeaders?: Readonly<Record<string, string>>;
}
function invalid(): never { throw new UpstreamHeaderError('invalid_configuration'); }
function validBeta(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value && /^[a-z0-9][a-z0-9-]*$/.test(value);
}
function checkPlatformAuth(headers: Headers): void {
  const authorization = headers.get('authorization');
  const apiKey = headers.get('x-api-key');
  let bearer: string | null = null;
  try {
    if (authorization !== null) {
      const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authorization);
      if (!match?.[1]) throw new Error();
      bearer = match[1]; getTokenDisplayPrefix('apiKey', bearer);
    }
    if (apiKey !== null) getTokenDisplayPrefix('apiKey', apiKey);
  } catch { throw new UpstreamHeaderError('invalid_downstream_auth'); }
  if (bearer !== null && apiKey !== null && bearer !== apiKey) throw new UpstreamHeaderError('conflicting_downstream_auth');
}
function connectionNames(headers: Headers): Set<string> {
  const value = headers.get('Connection');
  if (value === null) return new Set();
  if (value.length > 4096) throw new UpstreamHeaderError('invalid_downstream_headers');
  const names = value.split(',').map((name) => name.trim().toLowerCase());
  if (names.length > 64 || names.some((name) => !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name))) throw new UpstreamHeaderError('invalid_downstream_headers');
  return new Set(names);
}

/** Whitelist construction, never cloning downstream headers. Required upstream
 * auth is rebuilt even if a client names it in Connection. Only negotiated beta
 * values can cross from the client, and never across a non-Messages target.
 * This does not authenticate the platform Key; A27 owns authoritative lookup.
 */
export function buildUpstreamHeaders(options: UpstreamHeaderOptions): Headers {
  if (!options || !['chat', 'responses', 'messages'].includes(options.upstreamProtocol)
      || typeof options.upstreamKey !== 'string' || options.upstreamKey.trim() !== options.upstreamKey || !/^[\x21-\x7e]{1,16384}$/.test(options.upstreamKey)
      || /^s2a_(?:key|session|invite)_/.test(options.upstreamKey)
      || (options.stream !== undefined && typeof options.stream !== 'boolean')) invalid();
  const incoming = options.downstreamHeaders ?? new Headers();
  if (!(incoming instanceof Headers)) invalid();
  checkPlatformAuth(incoming);
  const hopNames = connectionNames(incoming);
  const output = new Headers({ 'Content-Type': 'application/json', Accept: options.stream ? 'text/event-stream' : 'application/json' });
  if (options.upstreamProtocol === 'messages') {
    output.set('x-api-key', options.upstreamKey);
    if (options.messages !== undefined && (options.messages === null || typeof options.messages !== 'object' || Array.isArray(options.messages)
        || Reflect.ownKeys(options.messages).some((key) => key !== 'version' && key !== 'allowedBetas'))) invalid();
    const version = options.messages?.version === undefined ? DEFAULT_ANTHROPIC_VERSION : options.messages.version;
    // Current supported version; introducing a new one requires explicit review.
    if (version !== DEFAULT_ANTHROPIC_VERSION) invalid();
    output.set('anthropic-version', version);
    const allowed = options.messages?.allowedBetas === undefined ? [] : options.messages.allowedBetas;
    if (!Array.isArray(allowed) || allowed.length > 32 || !allowed.every(validBeta) || new Set(allowed).size !== allowed.length) invalid();
    const requested = hopNames.has('anthropic-beta') ? null : incoming.get('anthropic-beta');
    if (requested !== null) {
      if (requested.length > 4096) throw new UpstreamHeaderError('unsupported_beta');
      const betas = requested.split(',').map((beta) => beta.trim());
      if (betas.length > 32 || betas.some((beta) => !validBeta(beta) || !allowed.includes(beta))) throw new UpstreamHeaderError('unsupported_beta');
      output.set('anthropic-beta', [...new Set(betas)].join(','));
    }
  } else output.set('Authorization', `Bearer ${options.upstreamKey}`);
  if (options.customHeaders !== undefined) {
    if (options.customHeaders === null || typeof options.customHeaders !== 'object' || Array.isArray(options.customHeaders)) invalid();
    const seen = new Set<string>();
    for (const field of Reflect.ownKeys(options.customHeaders)) {
      if (typeof field !== 'string') invalid();
      const name = field.toLowerCase();
      const descriptor = Object.getOwnPropertyDescriptor(options.customHeaders, field);
      if (!descriptor || !('value' in descriptor)) invalid();
      const value: unknown = descriptor.value;
      if (options.upstreamProtocol === 'messages' || !['openai-organization', 'openai-project'].includes(name) || seen.has(name)
          || typeof value !== 'string' || value.trim() !== value || !/^[A-Za-z0-9_-]{1,128}$/.test(value) || /^s2a_/.test(value)) invalid();
      // Refuse this ambiguous request instead of forwarding a named hop header
      // or silently stripping trusted tenant selection and using a different tenant.
      if (hopNames.has(name)) throw new UpstreamHeaderError('invalid_downstream_headers');
      seen.add(name); output.set(name, value);
    }
  }
  return output;
}
