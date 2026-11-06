import type { ImageGenerateInput, ImageJob } from '@cheapai/contracts/images';
import { validateUpstreamBaseUrl } from '../gateway/upstream-url';
import type { SelectionRow } from './repository';
import { readDiagnosticBody } from '../gateway/diagnostic-body';
import { redactDiagnosticBody, redactDiagnosticText } from '../gateway/diagnostic-redaction';

export class ImageProviderError extends Error {
  readonly diagnostic: ImageJob['diagnostic'];
  constructor(
    readonly reason:
      'provider_rejected' | 'provider_unavailable' | 'invalid_image' | 'delivery_failed',
    options?: ErrorOptions & { diagnostic?: ImageJob['diagnostic'] },
  ) {
    super(reason, options);
    this.diagnostic = options?.diagnostic;
  }
}
export function imageEndpoint(base: string): URL {
  const url = validateUpstreamBaseUrl(base);
  const prefix = url.pathname.replace(/\/+$/u, '');
  url.pathname = `${prefix}${prefix.endsWith('/v1') ? '' : '/v1'}/images/generations`;
  return url;
}
export function decodeImage(payload: unknown): { bytes: Uint8Array; mediaType: string } {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('data' in payload) ||
    !Array.isArray(payload.data) ||
    payload.data.length !== 1
  )
    throw new ImageProviderError('invalid_image');
  const data = payload.data[0] as { b64_json?: unknown };
  const encoded = data?.b64_json;
  if (typeof encoded !== 'string') throw new ImageProviderError('invalid_image');
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new ImageProviderError('invalid_image');
  }
  if (binary.length === 0) throw new ImageProviderError('invalid_image');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = binary.startsWith('RIFF') && binary.slice(8, 12) === 'WEBP';
  if (!png && !jpeg && !webp) throw new ImageProviderError('invalid_image');
  return { bytes, mediaType: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' };
}
export async function generateImage(
  fetcher: typeof fetch,
  channel: { baseUrl: string; upstreamKey: string },
  config: SelectionRow,
  input: ImageGenerateInput,
  signal: AbortSignal,
) {
  let response: Response;
  try {
    response = await fetcher(imageEndpoint(channel.baseUrl), {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${channel.upstreamKey}`,
      },
      body: JSON.stringify({
        model: config.upstream_model,
        prompt: input.prompt,
        size: input.size,
        n: 1,
        ...(config.quality === 'default' ? {} : { quality: config.quality }),
        ...(config.response_format === 'default'
          ? {}
          : { response_format: config.response_format }),
      }),
    });
  } catch (cause) {
    throw new ImageProviderError('delivery_failed', { cause });
  }
  if (!response.ok) {
    const captured = await readDiagnosticBody(response.body);
    const safe = redactDiagnosticBody(captured.text, { secrets: [channel.upstreamKey], truncated: captured.truncated });
    let code: string | null = null;
    try {
      const parsed = JSON.parse(safe.body ?? '');
      if (typeof parsed.error?.code === 'string') code = parsed.error.code;
    } catch { /* A non-JSON provider body is still useful diagnostic text. */ }
    const providerId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
    const diagnostic = {
      message: safe.body || response.statusText || `HTTP ${response.status}`,
      status: response.status, code,
      request_id: providerId ? redactDiagnosticText(providerId, [channel.upstreamKey]).text : null,
    };
    throw new ImageProviderError(
      response.status >= 400 && response.status < 500 ? 'provider_rejected' : 'delivery_failed',
      { cause: diagnostic, diagnostic },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new ImageProviderError(signal.aborted ? 'delivery_failed' : 'invalid_image', { cause });
  }
  return decodeImage(payload);
}
