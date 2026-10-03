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

describe('chat text fidelity and HTTP expiry', () => {
  it('preserves whitespace, empty delta, multiline content and empty generating assistants', async () => {
    const content = '  first\n\n```ts\n  const a = 1;\n```\n';
    const final = { ...assistantMessage, content };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse([
      `event: meta\ndata: ${JSON.stringify({ conversation, userMessage: { ...userMessage, content }, assistantMessage: { ...assistantMessage, content: '', status: 'generating' } })}\n\n`,
      `event: delta\ndata: ${JSON.stringify({ text: '' })}\n\n`,
      `event: delta\ndata: ${JSON.stringify({ text: content })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ message: final })}\n\n`,
    ]));
    const api = createChatApi({ fetch: fetcher, getCsrfToken: () => 'csrf' });
    const deltas: string[] = [];
    const result = await api.sendMessage(conversation.id, { operationId: 'whitespace', conversationVersion: 1, groupId: 'group-1', modelId: 'model-1', content }, { onDelta: text => { deltas.push(text); } });
    expect(result).toMatchObject({ message: { content } });
    expect(deltas).toEqual(['', content]);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).content).toBe(content);
    for (const empty of ['', ' \n\t ']) await expect(api.sendMessage(conversation.id, { operationId: 'empty', conversationVersion: 1, groupId: 'group-1', modelId: 'model-1', content: empty })).rejects.toMatchObject({ kind: 'request' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('expires HTTP 401 before error decoding but never an SSE provider error', async () => {
    const { bindSessionExpiry } = await import('../../apps/web/src/api/session-expiry.js');
    const notices: unknown[] = [];
    const unbind = bindSessionExpiry(() => ({ generation: 4, userId: 'one' }), notice => notices.push(notice));
    const input = { operationId: 'expiry', conversationVersion: 1, groupId: 'group-1', modelId: 'model-1', content: 'hello' };
    try {
      const http = createChatApi({ fetch: async () => new Response('<html>no</html>', { status: 401 }), getCsrfToken: () => 'csrf' });
      await expect(http.sendMessage(conversation.id, input)).rejects.toMatchObject({ status: 401 });
      const sse = createChatApi({ fetch: async () => streamResponse(['event: error\ndata: {"code":"unauthorized","message":"upstream 401"}\n\n']), getCsrfToken: () => 'csrf' });
      await expect(sse.sendMessage(conversation.id, input)).rejects.toMatchObject({ status: 200, code: 'unauthorized' });
      expect(notices).toEqual([{ generation: 4, userId: 'one', path: '/api/v1/chat/conversations/conversation-1/messages' }]);
    } finally { unbind(); }
  });
});

describe('history and model composables', () => {
  it('single-flights append, keeps its failed cursor and preserves local version/deletion changes', async () => {
    const { useConversationHistory } = await import('../../apps/web/src/composables/chat/useConversationHistory.js');
    const list = vi.fn().mockResolvedValueOnce({ items: [conversation], nextCursor: 'next' });
    const history = useConversationHistory({ list, isOwnerCurrent: () => true });
    await history.load('one');
    let release!: (value: unknown) => void;
    list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = history.loadMore('one'); await history.loadMore('one');
    expect(list).toHaveBeenCalledTimes(2);
    history.remove(conversation.id);
    const newer = { ...conversation, id: 'newer', version: 5, title: 'renamed', updatedAt: conversation.updatedAt + 5 };
    history.upsert(newer);
    release({ items: [conversation, { ...newer, version: 1, title: 'stale' }], nextCursor: 'last' });
    await pending;
    expect(history.conversations.value).toEqual([newer]);
    list.mockRejectedValueOnce(new Error('temporary'));
    await history.loadMore('one');
    expect(history.cursor.value).toBe('last');
    expect(history.error.value).toBe('temporary');
    list.mockResolvedValueOnce({ items: [], nextCursor: null });
    await history.retry('one');
    expect(list.mock.calls.slice(-2).map(value => value[0])).toEqual(['last', 'last']);
    expect(history.cursor.value).toBeNull();
  });

  it('drops append responses superseded by refresh and all responses after owner reset', async () => {
    const { useConversationHistory } = await import('../../apps/web/src/composables/chat/useConversationHistory.js');
    const list = vi.fn().mockResolvedValueOnce({ items: [conversation], nextCursor: 'next' });
    const history = useConversationHistory({ list, isOwnerCurrent: () => true });
    await history.load('one');
    let release!: (value: unknown) => void;
    list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const append = history.loadMore('one');
    list.mockResolvedValueOnce({ items: [{ ...conversation, version: 3 }], nextCursor: null });
    await history.load('one');
    release({ items: [{ ...conversation, id: 'late' }], nextCursor: 'stale' }); await append;
    expect(history.conversations.value.map(item => item.version)).toEqual([3]);
    expect(history.cursor.value).toBeNull();
    list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const stale = history.load('one'); history.reset();
    release({ items: [conversation], nextCursor: 'stale' }); await stale;
    expect(history.conversations.value).toEqual([]); expect(history.loading.value).toBe(false);
  });

  it('rejects repeated pagination cursors without advancing or dropping existing rows', async () => {
    const { useConversationHistory } = await import('../../apps/web/src/composables/chat/useConversationHistory.js');
    const list = vi.fn().mockResolvedValueOnce({ items: [conversation], nextCursor: 'same' })
      .mockResolvedValueOnce({ items: [], nextCursor: 'same' });
    const history = useConversationHistory({ list, isOwnerCurrent: () => true });
    await history.load('one'); await history.loadMore('one');
    expect(history.error.value).toContain('重复'); expect(history.cursor.value).toBe('same');
    expect(history.conversations.value).toEqual([conversation]);
  });

  it('chooses conversation, saved selection, then first usable model and ignores stale catalog reads', async () => {
    const { useChatModelSelection } = await import('../../apps/web/src/composables/chat/useChatModelSelection.js');
    const storage = new Map<string, string>();
    vi.stubGlobal('window', { sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
    let selection: { groupId: string; modelId: string } | null = { groupId: 'g', modelId: 'second' };
    const models = vi.fn().mockResolvedValue({ items: [ { id: 'empty', name: 'empty', billingMultiplier: '1', models: [] },
      { id: 'g', name: 'g', billingMultiplier: '1', models: [{ publicModelId: 'first' }, { publicModelId: 'second' }] } ] });
    try {
      const catalog = useChatModelSelection({ models, isOwnerCurrent: () => true, conversation: () => selection, onError: () => undefined });
      await catalog.load('one'); expect(catalog.selectedModelId.value).toBe('second');
      selection = null; catalog.reset(); await catalog.load('one'); expect(catalog.selectedModelId.value).toBe('second');
      storage.clear(); catalog.reset(); await catalog.load('one'); expect(catalog.selectedModelId.value).toBe('first');
      let release!: (value: unknown) => void;
      models.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const pending = catalog.load('one'); catalog.reset(); release({ items: [] }); await pending;
      expect(catalog.groups.value).toEqual([]); expect(catalog.loading.value).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});
