import type { ImageGenerateInput } from '@cheapai/contracts/images';
import { validateUpstreamBaseUrl } from '../gateway/upstream-url';
import type { SelectionRow } from './repository';

export class ImageProviderError extends Error {
  constructor(
    readonly reason:
      'provider_rejected' | 'provider_unavailable' | 'invalid_image' | 'result_unknown',
  ) {
    super(reason);
  }
}
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const responseLimit = Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 65536;

export function imageEndpoint(base: string): URL {
  const url = validateUpstreamBaseUrl(base);
  const prefix = url.pathname.replace(/\/+$/u, '');
  url.pathname = `${prefix}${prefix.endsWith('/v1') ? '' : '/v1'}/images/generations`;
  return url;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ImageProviderError('invalid_image');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > responseLimit || chunks.length > 16384)
        throw new ImageProviderError('invalid_image');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error instanceof ImageProviderError ? error : new ImageProviderError('invalid_image');
  } finally {
    reader.releaseLock();
  }
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
  if (
    typeof encoded !== 'string' ||
    encoded.length > responseLimit ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  )
    throw new ImageProviderError('invalid_image');
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new ImageProviderError('invalid_image');
  }
  if (binary.length === 0 || binary.length > IMAGE_MAX_BYTES)
    throw new ImageProviderError('invalid_image');
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
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
      redirect: 'error',
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
  } catch {
    throw new ImageProviderError('result_unknown');
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new ImageProviderError(
      response.status >= 400 && response.status < 500 ? 'provider_rejected' : 'result_unknown',
    );
  }
  return decodeImage(await boundedJson(response));
}
