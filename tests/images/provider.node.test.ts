import { describe, expect, it, vi } from 'vitest';
import { decodeImage, imageEndpoint, generateImage } from '../../apps/worker/images/provider';
import type { SelectionRow } from '../../apps/worker/images/repository';
describe('image provider boundary', () => {
  it('preserves channel prefixes and query parameters', () => {
    expect(String(imageEndpoint('https://provider.invalid/proxy/v1/?tenant=one'))).toBe(
      'https://provider.invalid/proxy/v1/images/generations?tenant=one',
    );
    expect(String(imageEndpoint('https://provider.invalid'))).toBe(
      'https://provider.invalid/v1/images/generations',
    );
  });
  it('rejects remote URLs and executable image formats without fetching them', () => {
    expect(() => decodeImage({ data: [{ url: 'http://127.0.0.1/private' }] })).toThrow();
    expect(() =>
      decodeImage({ data: [{ b64_json: btoa('<svg onload="alert(1)"></svg>') }] }),
    ).toThrow();
    expect(() => decodeImage({ data: [] })).toThrow();
  });
  it('accepts provider results larger than the former 8 MiB cap', async () => {
    const bytes = Buffer.alloc(9 * 1024 * 1024);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const result = decodeImage({ data: [{ b64_json: bytes.toString('base64') }] });
    expect(result.bytes.byteLength).toBe(bytes.byteLength);
    expect(result.mediaType).toBe('image/png');
  });
  it('does not reject a valid JSON response based on transport chunk count', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < 16400; i++) controller.enqueue(new Uint8Array([32]));
          controller.enqueue(
            new TextEncoder().encode(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgo=' }] })),
          );
          controller.close();
        },
      }),
    );
    const result = await generateImage(
      vi.fn(async () => response) as typeof fetch,
      { baseUrl: 'https://provider.invalid', upstreamKey: 'secret' },
      {
        upstream_model: 'image-model',
        quality: 'default',
        response_format: 'default',
      } as SelectionRow,
      { operationId: 'one', modelId: 'model', groupId: 'group', prompt: 'cat', size: '1024x1024' },
      new AbortController().signal,
    );
    expect(result.mediaType).toBe('image/png');
  });
  it('requests one image and configured parameters without forwarding browser credentials', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [{ b64_json: 'invalid' }] }));
    await expect(
      generateImage(
        fetcher as typeof fetch,
        { baseUrl: 'https://provider.invalid', upstreamKey: 'secret' },
        { upstream_model: 'dall-e-3', quality: 'hd', response_format: 'b64_json' } as SelectionRow,
        {
          operationId: 'one',
          modelId: 'image-model',
          groupId: 'group',
          prompt: 'cat',
          size: '1024x1024',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const args = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(args[1].body as string)).toMatchObject({
      model: 'dall-e-3',
      n: 1,
      quality: 'hd',
      response_format: 'b64_json',
    });
    expect(new Headers(args[1].headers).get('Cookie')).toBeNull();
    expect(args[1].redirect).toBe('manual');
  });
});
