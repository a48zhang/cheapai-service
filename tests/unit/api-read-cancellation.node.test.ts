import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../packages/api-client/src/client';
import { createGroupsApi } from '../../packages/api-client/src/groups';

const origin = 'https://console.example';

describe('API read cancellation', () => {
  it('forwards a caller signal through an injected API factory and reports a pre-aborted GET', async () => {
    const controller = new AbortController();
    controller.abort();
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      signals.push(init?.signal);
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return Response.json({ data: {}, request_id: 'read-cancel-1' });
    };
    const api = createGroupsApi(createApiClient({ fetch: fetcher }));

    await expect(api.get('group-1', { signal: controller.signal })).rejects.toMatchObject({
      kind: 'aborted',
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBe(controller.signal);
  });

  it('reports an abort while decoding a GET response as an aborted read', async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      transportSignal = init?.signal;
      return {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => {
          controller.abort();
          throw new DOMException('Aborted while reading', 'AbortError');
        },
      } as unknown as Response;
    };
    const api = createGroupsApi(createApiClient({ fetch: fetcher }));

    await expect(api.get('group-1', { signal: controller.signal })).rejects.toMatchObject({
      kind: 'aborted',
    });
    expect(transportSignal).toBe(controller.signal);
  });

  it('passes the same signal to every page fetched by listAll', async () => {
    const controller = new AbortController();
    const requests: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
    const groups = [
      {
        id: 'group-1',
        name: 'First',
        status: 'active',
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        channelIds: [],
      },
      {
        id: 'group-2',
        name: 'Second',
        status: 'active',
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        channelIds: [],
      },
    ];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input), origin);
      requests.push({ url: url.toString(), signal: init?.signal });
      const secondPage = url.searchParams.get('cursor') === 'page-2';
      return Response.json({
        data: { items: [groups[secondPage ? 1 : 0]], nextCursor: secondPage ? null : 'page-2' },
        request_id: secondPage ? 'read-page-2' : 'read-page-1',
      });
    };
    const api = createGroupsApi(createApiClient({ fetch: fetcher }));

    const result = await api.listAll({}, { signal: controller.signal });

    expect(result.map((group) => group.id)).toEqual(['group-1', 'group-2']);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => new URL(request.url).searchParams.get('cursor'))).toEqual([
      null,
      'page-2',
    ]);
    expect(requests.map((request) => new URL(request.url).searchParams.get('limit'))).toEqual([
      '20',
      '20',
    ]);
    for (const request of requests) expect(request.signal).toBe(controller.signal);
  });
});
