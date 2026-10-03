import { describe, expect, it, vi } from 'vitest';
import { createChatSseStream } from '../../apps/worker/chat/stream';
import type { ChatGatewayEvent } from '../../apps/worker/chat/stream';
import type { Message } from '../../apps/worker/chat/types';

const message = (content = ''): Message => ({
  id: 'assistant-1', conversationId: 'conversation-1', turnIndex: 1, role: 'assistant', content,
  status: 'completed', variant: 1, selected: true, requestId: 'request-1', groupId: 'group-1', modelId: 'model-1',
  createdAt: 1, updatedAt: 2,
});

describe('web chat SSE persistence bridge', () => {
  it('emits each fast delta once while checkpointing the same ABC text', async () => {
    const persisted: string[] = [];
    const source = (async function* (): AsyncGenerator<ChatGatewayEvent> {
      yield { type: 'delta', text: 'A' };
      yield { type: 'delta', text: 'B' };
      yield { type: 'delta', text: 'C' };
      yield { type: 'done' };
    })();
    const final = message('ABC');
    const body = createChatSseStream({ conversation: { id: 'conversation-1' }, userMessage: null, assistantMessage: message() },
      { requestId: 'request-1', source, terminal: 'completed' }, {
        onDelta: text => persisted.push(text),
        onDone: async () => final,
        onFailed: async () => final,
        onCancelled: async () => final,
      });
    const wire = await new Response(body).text();
    const deltas = [...wire.matchAll(/event: delta\ndata: (\{[^\n]+\})/g)].map(match => JSON.parse(match[1]!).text).join('');
    expect(deltas).toBe('ABC');
    expect(persisted.join('')).toBe('ABC');
    expect(wire).toContain('event: done');
  });

  it('closes with a visible persistence error when final save throws', async () => {
    const source = (async function* (): AsyncGenerator<ChatGatewayEvent> {
      yield { type: 'delta', text: 'answer' };
      yield { type: 'done' };
    })();
    let failed = 0;
    const body = createChatSseStream({ conversation: {}, userMessage: null, assistantMessage: message() },
      { requestId: 'request-2', source, terminal: 'completed' }, {
        onDelta: async () => undefined,
        onDone: async () => { throw new Error('synthetic final persistence failure'); },
        onFailed: async () => { failed += 1; return null; },
        onCancelled: async () => null,
      });
    const wire = await new Response(body).text();
    expect(failed).toBe(1);
    expect(wire).toContain('event: error');
    expect(wire).toContain('persistence_error');
  });

  it('closes with an error even when the failed-state callback also throws', async () => {
    const source = (async function* (): AsyncGenerator<ChatGatewayEvent> {
      yield { type: 'error', code: 'upstream_error', message: 'synthetic failure' };
    })();
    const body = createChatSseStream({ conversation: {}, userMessage: null, assistantMessage: message() },
      { requestId: 'request-3', source }, {
        onDelta: async () => undefined,
        onDone: async () => message(),
        onFailed: async () => { throw new Error('synthetic failed-state persistence failure'); },
        onCancelled: async () => null,
      });
    const wire = await new Response(body).text();
    expect(wire).toContain('event: error');
    expect(wire).toContain('persistence_error');
  });

  it('runs cancellation finalization when the last checkpoint throws', async () => {
    const source = (async function* (): AsyncGenerator<ChatGatewayEvent> {
      yield { type: 'delta', text: 'partial' };
      await new Promise<void>(() => undefined);
    })();
    let checkpointed = 0;
    let cancelled = 0;
    const body = createChatSseStream({ conversation: {}, userMessage: null, assistantMessage: message() },
      { requestId: 'request-4', source }, {
        onDelta: async () => { checkpointed += 1; throw new Error('synthetic checkpoint failure'); },
        onDone: async () => message(),
        onFailed: async () => null,
        onCancelled: async () => { cancelled += 1; return message(); },
      });
    const reader = body.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    expect(checkpointed).toBe(1);
    expect(cancelled).toBe(1);
  });

  it('accepts EOF without [DONE] only with an authoritative completed gateway state', async () => {
    const source = (async function* (): AsyncGenerator<ChatGatewayEvent> { yield { type: 'delta', text: 'eof' }; })();
    const completed = createChatSseStream({ conversation: {}, userMessage: null, assistantMessage: message() },
      { requestId: 'request-5', source, resolveTerminal: async () => ({ terminal: 'completed', billingStatus: 'settled' }) }, {
        onDelta: async () => undefined, onDone: async () => message(), onFailed: async () => null, onCancelled: async () => null,
      });
    expect(await new Response(completed).text()).toContain('event: done');

    const noAuthority = (async function* (): AsyncGenerator<ChatGatewayEvent> { yield { type: 'delta', text: 'eof' }; })();
    const incomplete = createChatSseStream({ conversation: {}, userMessage: null, assistantMessage: message() },
      { requestId: 'request-6', source: noAuthority }, {
        onDelta: async () => undefined, onDone: async () => message(), onFailed: async () => null, onCancelled: async () => null,
      });
    expect(await new Response(incomplete).text()).toContain('incomplete_stream');
  });
});

describe('B01 termination ownership and bounded failures', () => {
  it('cancels execution before saving a checkpoint failure and closes the reader', async () => {
    const order: string[] = [];
    const source = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'delta', text: 'x'.repeat(2048) })}\n\n`));
    }, cancel() { order.push('reader-cancel'); } });
    const body = createChatSseStream({ conversation: {}, userMessage: null, assistantMessage: message() },
      { requestId: 'checkpoint', source, cancel() { order.push('execution-cancel'); } }, {
        onDelta: async () => { throw new Error('checkpoint rejected'); },
        onDone: async () => { throw new Error('must not complete'); },
        onFailed: async () => { order.push('failed-save'); return message(); },
        onCancelled: async () => { throw new Error('must not classify failure as user cancel'); },
      });
    const wire = await new Response(body).text();
    expect(order.indexOf('execution-cancel')).toBeLessThan(order.indexOf('failed-save'));
    expect(order.filter(value => value === 'execution-cancel')).toHaveLength(1);
    expect(order).toContain('reader-cancel');
    expect(source.locked).toBe(false);
    expect(wire.match(/event: error/g)).toHaveLength(1);
    expect(wire).not.toContain('event: done');
  });

  it('request abort wakes a hanging read without requiring downstream cancel', async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const onCancelled = vi.fn(async () => message());
    const source = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}), cancel });
    const body = createChatSseStream({ conversation: {}, userMessage: null, assistantMessage: message() },
      { requestId: 'hanging-read', source, cancel }, {
        onDelta: async () => {}, onDone: async () => message(), onFailed: async () => null, onCancelled,
      }, { signal: abort.signal });
    const wire = new Response(body).text();
    abort.abort();
    expect(await wire).toContain('event: done');
    expect(onCancelled).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it('does not let a late abort overwrite completion already being saved', async () => {
    const abort = new AbortController();
    let saved!: (value: Message) => void;
    let started!: () => void;
    const saving = new Promise<void>(resolve => { started = resolve; });
    const onCancelled = vi.fn(async () => null);
    const cancel = vi.fn();
    const source = (async function* (): AsyncGenerator<ChatGatewayEvent> { yield { type: 'done' }; })();
    const body = createChatSseStream({ conversation: {}, userMessage: null, assistantMessage: message() },
      { requestId: 'late-abort', source, cancel }, {
        onDelta: async () => {}, onDone: () => { started(); return new Promise(resolve => { saved = resolve; }); },
        onFailed: async () => null, onCancelled,
      }, { signal: abort.signal });
    const wire = new Response(body).text();
    await saving;
    abort.abort();
    saved(message());
    expect(await wire).toContain('event: done');
    expect(onCancelled).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('bounds hung cancellation and final saving without duplicate finalization or timers', async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const onFailed = vi.fn(() => new Promise<Message | null>(() => {}));
      const source = (async function* (): AsyncGenerator<ChatGatewayEvent> { yield { type: 'error', code: 'upstream_error', message: 'failed' }; })();
      const body = createChatSseStream({ conversation: {}, userMessage: null, assistantMessage: message() },
        { requestId: 'hung-save', source, cancel }, {
          onDelta: async () => {}, onDone: async () => message(), onFailed, onCancelled: async () => null,
        });
      const wire = new Response(body).text();
      await vi.advanceTimersByTimeAsync(6000);
      expect(await wire).toContain('persistence_error');
      expect(cancel).toHaveBeenCalledOnce();
      expect(onFailed).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('does not start a conflicting failed write when completed persistence times out', async () => {
    vi.useFakeTimers();
    try {
      const onFailed = vi.fn(async () => null);
      const source = (async function* (): AsyncGenerator<ChatGatewayEvent> { yield { type: 'done' }; })();
      const body = createChatSseStream({ conversation: {}, userMessage: null, assistantMessage: message() },
        { requestId: 'unknown-save', source }, {
          onDelta: async () => {}, onDone: () => new Promise<Message>(() => {}), onFailed, onCancelled: async () => null,
        });
      const wire = new Response(body).text();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await wire).toContain('persistence_error');
      expect(onFailed).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
