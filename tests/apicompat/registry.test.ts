import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createProtocolRegistry, defaultProtocolRegistry } from '../../packages/apicompat/index.js';
import type { AnyProtocolRegistration, RequestWire, ResponseWire } from '../../packages/apicompat/index.js';
import type { Protocol, SseFrame } from '../../packages/apicompat/types/shared.js';

const protocols: Protocol[] = ['chat', 'responses', 'messages'];
const context = (protocol: Protocol) => ({ capabilities: { protocol, features: ['streaming' as const], maxOutputTokens: 64 }, outputTokenLimit: 16 });
const responseContext = { identity: { responseId: 'public_id', upstreamResponseId: 'native_id' }, targetModel: 'public-model', createdAt: 1, idFor: (kind: string, key: string) => `${kind}_${key}` };
const requests: RequestWire = {
  chat: { model: 'public-model', messages: [{ role: 'user', content: 'Synthetic text' }] },
  responses: { model: 'public-model', input: 'Synthetic text' },
  messages: { model: 'public-model', max_tokens: 16, messages: [{ role: 'user', content: 'Synthetic text' }] },
};
const responses: ResponseWire = {
  chat: { id: 'native_id', object: 'chat.completion', created: 1, model: 'provider', choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } },
  responses: { id: 'native_id', object: 'response', created_at: 1, model: 'provider', status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } },
  messages: { id: 'native_id', type: 'message', role: 'assistant', model: 'provider', content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
};
const frame = (value: unknown, event?: string): SseFrame => ({ data: JSON.stringify(value), ...(event ? { event } : {}) });
function frames(protocol: Protocol): SseFrame[] {
  if (protocol === 'chat') {
    const base = { id: 'native_id', object: 'chat.completion.chunk', model: 'provider', created: 1 };
    return [frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }] }),
      frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      frame({ ...base, choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }), { data: '[DONE]' }];
  }
  if (protocol === 'responses') return [
    frame({ type: 'response.created', sequence_number: 0, response: { ...responses.responses, status: 'in_progress', usage: null } }, 'response.created'),
    frame({ type: 'response.completed', sequence_number: 1, response: responses.responses }, 'response.completed'),
  ];
  return [
    { type: 'message_start', message: { ...responses.messages, content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ].map(event => frame(event, event.type));
}

describe('P22 default production registry: all direct combinations', () => {
  it('exposes the package root and declares all nine direct directions for both modes', () => {
    const require = createRequire(new URL('../../apps/worker/package.json', import.meta.url));
    expect(require.resolve('@sub2api/apicompat').replaceAll('\\', '/')).toMatch(/packages\/apicompat\/index\.ts$/);
    expect(defaultProtocolRegistry.directions).toEqual(protocols.flatMap(from => protocols.map(to => ({ from, to }))));
    for (const from of protocols) for (const to of protocols) for (const streaming of [false, true]) {
      expect(defaultProtocolRegistry.available({ from, to, streaming })).toBe(true);
      const found = defaultProtocolRegistry.lookup({ from, to, streaming }, context(to));
      expect(found.ok).toBe(true);
    }
  });

  it.each(protocols)('uses real %s native JSON adapters and independent upstream usage/error encoding', protocol => {
    const resolved = defaultProtocolRegistry.lookup({ from: protocol, to: protocol, streaming: false }, context(protocol));
    if (!resolved.ok) throw new Error('Expected native registration');
    const request = resolved.value.request.convert(requests[protocol], { targetModel: 'provider-model' });
    expect(request).toMatchObject({ ok: true, value: { model: 'provider-model' } });
    const response = resolved.value.response.convert(responses[protocol], responseContext);
    expect(response).toMatchObject({ ok: true, value: { body: { id: 'public_id', model: 'public-model' }, terminal: { status: 'completed' } } });
    expect(resolved.value.usage.protocol).toBe(protocol);
    expect(resolved.value.usage.json(responses[protocol])).toMatchObject({ quality: 'complete', protocol, counts: { inputTokens: 2, outputTokens: 3 } });
    const error = resolved.value.error.convert({ kind: 'upstream_error', code: 'private', message: 'PRIVATE SECRET' });
    expect(resolved.value.error.to).toBe(protocol); expect(JSON.stringify(error)).not.toContain('PRIVATE SECRET');
    expect(responses[protocol].id).toBe('native_id');
  });

  it.each(protocols)('uses the real %s native SSE lifecycle, keeping original usage outside converted wire data', protocol => {
    const resolved = defaultProtocolRegistry.lookup({ from: protocol, to: protocol, streaming: true }, context(protocol));
    if (!resolved.ok) throw new Error('Expected native registration');
    const stream = resolved.value.stream.create(responseContext, { unknownEventPolicy: 'reject', maxBufferedBytes: 32768 });
    if (!stream.ok) throw new Error('Expected native stream session');
    const originalUsage = resolved.value.usage.createStream();
    const output: SseFrame[] = [];
    let terminal: import('../../packages/apicompat/types/shared.js').TerminalState | undefined;
    for (const original of frames(protocol)) {
      originalUsage.push(original);
      const step = stream.value.push(original); output.push(...step.events); terminal ??= step.terminal;
    }
    terminal ??= stream.value.finish({ kind: 'eof' }).terminal;
    expect(terminal?.status).toBe('completed');
    if (!terminal) throw new Error('Expected terminal');
    expect(originalUsage.finish(terminal)).toMatchObject({ quality: 'complete', protocol, counts: { inputTokens: 2, outputTokens: 3 } });
    expect(output.length).toBeGreaterThan(0);
    expect(JSON.stringify(output)).toContain('public_id');
    expect(stream.value.finish({ kind: 'eof' }).events).toEqual([]);
  });

  it.each(protocols)('preserves %s native extensions independently of legacy permissions', protocol => {
    const request = { ...requests[protocol], vendor_hint: 'allowed-value' };
    const strict = defaultProtocolRegistry.lookup({ from: protocol, to: protocol, streaming: false }, context(protocol));
    if (!strict.ok) throw new Error();
    expect(strict.value.request.convert(request, { targetModel: 'provider' }).ok).toBe(true);
    const allowed = defaultProtocolRegistry.lookup({ from: protocol, to: protocol, streaming: false }, {
      ...context(protocol), capabilities: { ...context(protocol).capabilities, nativeExtensions: [{ scope: 'request', name: 'vendor_hint' }, { scope: 'content', name: 'vendor_hint' }] },
    });
    if (!allowed.ok) throw new Error();
    expect(allowed.value.request.convert(request, { targetModel: 'provider' })).toMatchObject({ ok: true, value: { vendor_hint: 'allowed-value' } });
    const nested = protocol === 'responses'
      ? { ...requests.responses, input: [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: 'Hi', vendor_hint: 1 }] }] }
      : { ...requests[protocol], messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hi', vendor_hint: 1 }] }] };
    expect(allowed.value.request.convert(nested as RequestWire[Protocol], { targetModel: 'provider' }).ok).toBe(true);
    const stream = allowed.value.stream.create(responseContext, { unknownEventPolicy: 'reject', maxBufferedBytes: 32768 });
    if (!stream.ok) throw new Error();
    expect(stream.value.push(frame({ type: 'unregistered_event' }, 'unregistered_event')).terminal?.status).toBe('failed');
  });

  it('rejects mismatched trusted target context and invalid output limits', () => {
    expect(defaultProtocolRegistry.lookup({ from: 'chat', to: 'chat', streaming: false }, context('responses'))).toMatchObject({ ok: false });
    for (const outputTokenLimit of [0, 1.5, 100, Number.NaN]) expect(defaultProtocolRegistry.lookup({ from: 'chat', to: 'chat', streaming: false }, { ...context('chat'), outputTokenLimit })).toMatchObject({ ok: false });
  });

  it('binds the explicit request limit without adding a channel default', () => {
    const target = { capabilities: { protocol: 'messages' as const, features: [], maxOutputTokens: 64 }, outputTokenLimit: 8 };
    const chat = defaultProtocolRegistry.lookup({ from: 'chat', to: 'messages', streaming: false }, target);
    if (!chat.ok) throw new Error('Expected Chat→Messages registry entry');
    expect(chat.value.request.convert({ model: 'public', max_tokens: 8, messages: [{ role: 'user', content: 'probe' }] }, { targetModel: 'provider' }))
      .toMatchObject({ ok: true, value: { max_tokens: 8 } });
    const responses = defaultProtocolRegistry.lookup({ from: 'responses', to: 'messages', streaming: false }, target);
    if (!responses.ok) throw new Error('Expected Responses→Messages registry entry');
    expect(responses.value.request.convert({ model: 'public', max_output_tokens: 8, input: 'probe' }, { targetModel: 'provider' }))
      .toMatchObject({ ok: true, value: { max_tokens: 8 } });
    expect(target.capabilities).not.toHaveProperty('defaultOutputTokens');
  });

  it('binds each real cross-protocol request, JSON response and SSE adapter directly', () => {
    const responseContextWithSafeIds = { ...responseContext, idFor: (kind: string, key: string) => `${kind}_${key.replace(/[^A-Za-z0-9_-]/g, '_')}` };
    for (const from of protocols) for (const to of protocols) {
      if (from === to) continue;
      const found = defaultProtocolRegistry.lookup({ from, to, streaming: false }, context(to));
      if (!found.ok) throw new Error(`Missing registry direction ${from}->${to}`);
      expect(found.value.request.convert(requests[from], { targetModel: 'provider-model' }).ok).toBe(true);
      const upstream = to === 'messages' && from === 'responses'
        ? (() => { const { usage: _usage, ...withoutUsage } = responses.messages; return withoutUsage; })()
        : responses[to];
      expect(found.value.response.convert(upstream, responseContextWithSafeIds).ok).toBe(true);
      const stream = found.value.stream.create(responseContextWithSafeIds, { unknownEventPolicy: 'reject', maxBufferedBytes: 32768 });
      if (!stream.ok) throw new Error(`Cannot create ${to}->${from} stream`);
      let terminal: import('../../packages/apicompat/types/shared.js').TerminalState | undefined;
      for (const original of frames(to)) {
        const step = stream.value.push(original);
        terminal ??= step.terminal;
      }
      terminal ??= stream.value.finish({ kind: 'eof' }).terminal;
      expect(terminal?.status).toBe('completed');
    }
  });
});

describe('typed registry direction selection with injected routing stubs only', () => {
  // These stubs validate routing direction, NOT cross-protocol compatibility.
  it('selects request d->u and returns u->d while binding error to d and usage to u', () => {
    const registrations = protocols.flatMap(from => protocols.filter(to => to !== from).map(to => ({ from, to,
      create: () => ({ ok: true, value: {
        request: { from, to, convert: () => ({ ok: false, error: { kind: 'unsupported_feature', code: 'stub', message: 'stub' } }) },
        response: { from: to, to: from, convert: () => ({ ok: false, error: { kind: 'unsupported_feature', code: 'stub', message: 'stub' } }) },
        stream: { from: to, to: from, create: () => ({ ok: false, error: { kind: 'unsupported_feature', code: 'stub', message: 'stub' } }) },
      } }),
    }))) as unknown as AnyProtocolRegistration[];
    const registry = createProtocolRegistry(registrations);
    for (const registration of registrations) {
      const selected = registry.lookup({ from: registration.from, to: registration.to, streaming: true }, context(registration.to));
      if (!selected.ok) throw new Error('Expected routing stub');
      expect(selected.value.request).toMatchObject({ from: registration.from, to: registration.to });
      expect(selected.value.response).toMatchObject({ from: registration.to, to: registration.from });
      expect(selected.value.stream).toMatchObject({ from: registration.to, to: registration.from });
      expect(selected.value.error.to).toBe(registration.from); expect(selected.value.usage.protocol).toBe(registration.to);
      expect(defaultProtocolRegistry.available({ from: registration.from, to: registration.to, streaming: true })).toBe(true);
    }
  });

  it('rejects duplicate registrations and reversed factory components', () => {
    const wrong = { from: 'chat', to: 'responses', create: () => ({ ok: true, value: {
      request: { from: 'responses', to: 'chat' }, response: { from: 'responses', to: 'chat' }, stream: { from: 'responses', to: 'chat' },
    } }) } as unknown as AnyProtocolRegistration;
    expect(() => createProtocolRegistry([wrong, wrong])).toThrow('Duplicate');
    expect(createProtocolRegistry([wrong]).lookup({ from: 'chat', to: 'responses', streaming: false }, context('responses'))).toMatchObject({ ok: false, error: { code: 'adapter_direction_mismatch' } });
  });
});
