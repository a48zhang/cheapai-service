import { describe, expect, it, vi } from 'vitest';
import { createChatApi } from '@cheapai/api-client/chat';

const conversation = {
  id: 'conversation-1', title: '测试对话', groupId: 'group-1', modelId: 'model-1', version: 1,
  createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
};
const userMessage = {
  id: 'user-1', conversationId: conversation.id, turnIndex: 0, role: 'user' as const, content: '你好',
  status: 'completed' as const, variant: 1, selected: true, requestId: null, groupId: 'group-1', modelId: 'model-1',
  createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
};
const assistantMessage = {
  id: 'assistant-1', conversationId: conversation.id, turnIndex: 0, role: 'assistant' as const, content: '你好！',
  status: 'completed' as const, variant: 1, selected: true, requestId: 'request-1', groupId: 'group-1', modelId: 'model-1',
  createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
};

function streamResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

describe('React chat API stream client', () => {
  it('parses CRLF frames and omits output limits from web chat requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      'event: meta\r\ndata: ' + JSON.stringify({
        conversation,
        userMessage,
        assistantMessage: { ...assistantMessage, content: '', status: 'generating' },
      }) + '\r\n\r\n',
      'event: delta\r\ndata: {"text":"你好"}\r\n\r\n',
      'event: done\r\ndata: ' + JSON.stringify({ message: assistantMessage, billingStatus: 'settled' }) + '\r\n\r\n',
    ]));
    const meta = vi.fn();
    const deltas: string[] = [];
    const done = vi.fn();
    const api = createChatApi({ fetch: fetcher, getCsrfToken: () => 'csrf-token' });
    const result = await api.sendMessage(conversation.id, {
      operationId: 'operation-1', conversationVersion: conversation.version, groupId: 'group-1', modelId: 'model-1',
      content: '你好', maxOutputTokens: 64,
    }, {
      onMeta: value => { meta(value); },
      onDelta: text => { deltas.push(text); },
      onDone: (message, billingStatus) => { done({ message, billingStatus }); },
    });

    expect(result).toMatchObject({ kind: 'stream', message: assistantMessage, billingStatus: 'settled' });
    expect(meta).toHaveBeenCalledWith(expect.objectContaining({ assistantMessage: expect.objectContaining({ status: 'generating' }) }));
    expect(deltas).toEqual(['你好']);
    expect(done).toHaveBeenCalledWith({ message: assistantMessage, billingStatus: 'settled' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0]!;
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf-token');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ operationId: 'operation-1' });
    expect(body).not.toHaveProperty('maxOutputTokens');
  });

  it('decodes an idempotent replay without starting another generation', async () => {
    const replay: Response = new Response(JSON.stringify({
      data: { conversation, messages: [userMessage, assistantMessage], replayed: true }, request_id: 'request-1',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(replay);
    const api = createChatApi({ fetch: fetcher, getCsrfToken: () => 'csrf-token' });
    const result = await api.sendMessage(conversation.id, {
      operationId: 'operation-1', conversationVersion: conversation.version, groupId: 'group-1', modelId: 'model-1', content: '你好',
    });

    expect(result).toEqual({ kind: 'replay', replayed: true, conversation, messages: [userMessage, assistantMessage] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ operationId: 'operation-1' });
  });

  it('preserves whitespace and empty deltas while rejecting blank prompts before fetch', async () => {
    const content = '  first\n\n```ts\n  const a = 1;\n```\n';
    const final = { ...assistantMessage, content };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      `event: meta\ndata: ${JSON.stringify({
        conversation,
        userMessage: { ...userMessage, content },
        assistantMessage: { ...assistantMessage, content: '', status: 'generating' },
      })}\n\n`,
      'event: delta\ndata: {"text":""}\n\n',
      `event: delta\ndata: ${JSON.stringify({ text: content })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ message: final })}\n\n`,
    ]));
    const api = createChatApi({ fetch: fetcher, getCsrfToken: () => 'csrf' });
    const deltas: string[] = [];
    const result = await api.sendMessage(conversation.id, {
      operationId: 'whitespace', conversationVersion: 1, groupId: 'group-1', modelId: 'model-1', content,
    }, { onDelta: text => { deltas.push(text); } });

    expect(result).toMatchObject({ message: { content } });
    expect(deltas).toEqual(['', content]);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).content).toBe(content);
    for (const blank of ['', ' \n\t ']) {
      await expect(api.sendMessage(conversation.id, {
        operationId: 'empty', conversationVersion: 1, groupId: 'group-1', modelId: 'model-1', content: blank,
      })).rejects.toMatchObject({ kind: 'request' });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('expires the captured identity on HTTP 401 but preserves provider SSE errors as request errors', async () => {
    const identity = { epoch: 4, userId: 'user-1' };
    const notices: unknown[] = [];
    const options = {
      getCsrfToken: () => 'csrf',
      captureIdentity: () => identity,
      onUnauthorized: (requestIdentity: typeof identity, path: string) => notices.push({ ...requestIdentity, path }),
    };
    const input = {
      operationId: 'expiry', conversationVersion: 1, groupId: 'group-1', modelId: 'model-1', content: 'hello',
    };
    const http = createChatApi({
      ...options,
      fetch: async () => new Response('<html>no</html>', { status: 401 }),
    });
    await expect(http.sendMessage(conversation.id, input)).rejects.toMatchObject({ status: 401 });

    const onError = vi.fn();
    const provider = createChatApi({
      ...options,
      fetch: async () => streamResponse(['event: error\ndata: {"code":"unauthorized","message":"provider rejected the key"}\n\n']),
    });
    await expect(provider.sendMessage(conversation.id, input, { onError })).rejects.toMatchObject({
      kind: 'api', status: 200, code: 'unauthorized',
    });
    expect(onError).toHaveBeenCalledWith({ code: 'unauthorized', message: 'provider rejected the key' });
    expect(notices).toEqual([{ ...identity, path: '/api/v1/chat/conversations/conversation-1/messages' }]);
  });
});
