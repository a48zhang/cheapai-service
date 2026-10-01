import { DEFAULT_CONFIG } from '../config';
import { ApiError } from '../http';

export class GatewayInputError extends ApiError {
  readonly status: 400 | 413;
  readonly reason: 'invalid_headers' | 'invalid_json' | 'body_too_large' | 'request_cancelled';
  constructor(reason: GatewayInputError['reason']) {
    super(reason === 'body_too_large' ? 'payload_too_large' : 'invalid_request');
    this.name = 'GatewayInputError'; this.reason = reason;
    this.status = reason === 'body_too_large' ? 413 : 400;
  }
}

/** Shared bounded request reader for the three generation entry parsers. No
 * bindings, outbound requests or billing effects. Errors never include input. */
export async function readGatewayJson(request: Request, maxBytes = DEFAULT_CONFIG.gatewayBodyMaxBytes): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_CONFIG.gatewayBodyMaxBytes) {
    throw new ApiError('service_unavailable');
  }
  const media = request.headers.get('Content-Type')?.split(';').map(value => value.trim().toLowerCase());
  if (request.method !== 'POST' || !request.body || media?.[0] !== 'application/json'
    || media.slice(1).some(value => value !== 'charset=utf-8' && value !== 'charset="utf-8"')
    || ![null, 'identity'].includes(request.headers.get('Content-Encoding'))) throw new GatewayInputError('invalid_headers');
  if (request.signal.aborted) { void request.body.cancel().catch(() => undefined); throw new GatewayInputError('request_cancelled'); }
  const reader = request.body.getReader();
  // A byte ceiling alone does not bound an array of millions of tiny chunks.
  // Keep one geometrically grown allocation instead of retaining chunk objects.
  let bytes = new Uint8Array(Math.min(maxBytes, 4096));
  let size = 0; let finished = false;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (request.signal.aborted) throw new GatewayInputError('request_cancelled');
      if (part.done) { finished = true; break; }
      if (part.value.byteLength > maxBytes - size) throw new GatewayInputError('body_too_large');
      const required = size + part.value.byteLength;
      if (required > bytes.byteLength) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(required, bytes.byteLength * 2)));
        grown.set(bytes.subarray(0, size)); bytes = grown;
      }
      bytes.set(part.value, size); size = required;
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, size))); }
    catch { throw new GatewayInputError('invalid_json'); }
  } catch (error) {
    if (error instanceof GatewayInputError) throw error;
    throw new GatewayInputError(request.signal.aborted ? 'request_cancelled' : 'invalid_json');
  } finally {
    request.signal.removeEventListener('abort', abort);
    // A hostile/failed source's cancellation callback must not stall rejection.
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
