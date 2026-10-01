import { describe, expect, it, vi } from 'vitest';
import { createChatApi } from '../../apps/web/src/api/chat.js';

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

describe('web chat client', () => {
  it('parses CRLF SSE frames, forwards CSRF and configured output limit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      'event: meta\r\ndata: ' + JSON.stringify({ conversation, userMessage, assistantMessage: { ...assistantMessage, content: '', status: 'generating' } }) + '\r\n\r\n',
      'event: delta\r\ndata: {"text":"你好"}\r\n\r\n',
      'event: done\r\ndata: ' + JSON.stringify({ message: assistantMessage, billingStatus: 'settled' }) + '\r\n\r\n',
    ]));
    const deltas: string[] = [];
    const api = createChatApi({ fetch: fetcher, getCsrfToken: () => 'csrf-token' });
    const result = await api.sendMessage(conversation.id, {
      operationId: 'operation-1', conversationVersion: conversation.version, groupId: 'group-1', modelId: 'model-1',
      content: '你好', maxOutputTokens: 64,
    }, { onDelta: text => { deltas.push(text); } });

    expect(result).toMatchObject({ kind: 'stream', message: assistantMessage, billingStatus: 'settled' });
    expect(deltas).toEqual(['你好']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0]!;
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf-token');
    expect(JSON.parse(String(init?.body))).toMatchObject({ operationId: 'operation-1', maxOutputTokens: 64 });
  });

  it('decodes a replay response without issuing a second model request', async () => {
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
});
