/** Local browser-test entry only. Never used by the production Wrangler config. */
import worker from '../../apps/worker/index';
import type { Env } from '../../apps/worker/env';
export { Gate } from '../../apps/worker/limits/gate';

interface TestEnv extends Env { E2E_CONTROL_TOKEN: string }
const calls: { protocol: string; model: string; stream: boolean; platformCredentialLeaked: boolean }[] = [];
const answer = 'Local fixture answer';
const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15,
  input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
function body(protocol: string, model: string, id: string): Record<string, unknown> {
  if (protocol === 'chat') return { id, object: 'chat.completion', model, created: 1,
    choices: [{ index: 0, message: { role: 'assistant', content: answer, annotations: [] }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } };
  if (protocol === 'responses') return { id, object: 'response', model, created_at: 1, status: 'completed',
    output: [{ id: `${id}_item`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] }], usage };
  return { id, type: 'message', model, role: 'assistant', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}
function stream(protocol: string, model: string, id: string): Response {
  let frames: { event?: string; data: unknown }[];
  if (protocol === 'chat') {
    const base = { id, object: 'chat.completion.chunk', created: 1, model };
    frames = [{ data: { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] } },
      { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
      { data: { ...base, choices: [], usage: (body(protocol, model, id)).usage } }, { data: '[DONE]' }];
  } else if (protocol === 'messages') {
    frames = [{ type: 'message_start', message: { ...body(protocol, model, id), content: [], stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' }].map(value => ({ event: value.type, data: value }));
  } else {
    const item = { id: `${id}_item`, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    const part = { type: 'output_text', text: '', annotations: [] };
    const completePart = { ...part, text: answer };
    const completeItem = { ...item, status: 'completed', content: [completePart] };
    frames = [{ type: 'response.created', response: { ...body(protocol, model, id), output: [], status: 'in_progress', usage: null } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part },
      { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: answer },
      { type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text: answer },
      { type: 'response.content_part.done', output_index: 0, item_id: item.id, content_index: 0, part: completePart },
      { type: 'response.output_item.done', output_index: 0, item: completeItem },
      { type: 'response.completed', response: body(protocol, model, id) }].map((value, sequence_number) => ({ event: value.type, data: { ...value, sequence_number } }));
  }
  const encoder = new TextEncoder(); let index = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    const frame = frames[index++];
    if (!frame) { controller.close(); return; }
    controller.enqueue(encoder.encode(`${frame.event ? `event: ${frame.event}\n` : ''}data: ${typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)}\n\n`));
  } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } });
}

// No external generation can leave this isolated test entry, even for a bad URL.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init); const url = new URL(request.url);
  if (url.origin !== 'https://e2e-upstream.example.invalid' || request.method !== 'POST') throw new Error('External fetch is disabled in the local test Worker.');
  const protocol = url.pathname.endsWith('/chat/completions') ? 'chat' : url.pathname.endsWith('/responses') ? 'responses' : url.pathname.endsWith('/messages') ? 'messages' : '';
  if (!protocol) throw new Error('Unknown fixture endpoint.');
  const payload = await request.json<{ model: string; stream?: boolean }>();
  if (calls.length >= 200) throw new Error('Local fixture call budget exceeded.');
  calls.push({ protocol, model: payload.model, stream: payload.stream === true,
    platformCredentialLeaked: [...request.headers.values()].some(value => value.includes('s2a_key_')) });
  const id = `fixture_${crypto.randomUUID().replaceAll('-', '')}`;
  return payload.stream === true ? stream(protocol, payload.model, id) : Response.json(body(protocol, payload.model, id));
}) as typeof fetch;

export default { async fetch(request: Request, env: TestEnv, context: ExecutionContext) {
  const url = new URL(request.url);
  if (env.ENVIRONMENT !== 'local' || url.hostname !== '127.0.0.1') return new Response('Local test entry only', { status: 403 });
  if (url.pathname.startsWith('/__test__/')) {
    if (!env.E2E_CONTROL_TOKEN || request.headers.get('X-E2E-Control') !== env.E2E_CONTROL_TOKEN) return new Response('Not found', { status: 404 });
    if (url.pathname === '/__test__/policy' && request.method === 'POST') {
      const value = await request.json<{ registrationMode: string; emailVerificationEnabled: boolean }>();
      if (!['closed', 'open', 'invite'].includes(value.registrationMode) || typeof value.emailVerificationEnabled !== 'boolean') return new Response('Invalid fixture policy', { status: 400 });
      await env.DB.prepare("UPDATE settings SET value_json=?,version=version+1,updated_at=? WHERE key='registration'").bind(JSON.stringify(value), Date.now()).run();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/__test__/mail' && request.method === 'GET') {
      const mail = await env.CACHE.get(`e2e:mail:${url.searchParams.get('email') ?? ''}`);
      return new Response(mail ?? '{}', { status: mail ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/__test__/age-challenge' && request.method === 'POST') {
      const { email } = await request.json<{ email: string }>();
      await env.DB.prepare("UPDATE email_challenges SET created_at=created_at-61000,updated_at=updated_at-61000,send_requested_at=send_requested_at-61000 WHERE email_normalized=? AND consumed_at IS NULL").bind(email).run();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/__test__/calls' && request.method === 'GET') return Response.json({ calls });
    return new Response('Not found', { status: 404 });
  }
  const email = { async send(message: { to?: unknown; text?: unknown }) {
    if (typeof message.to !== 'string' || typeof message.text !== 'string') throw new Error('Unexpected local email shape');
    const code = message.text.match(/\b[0-9]{6}\b/)?.[0];
    if (!code) throw new Error('Missing local email code');
    const key = `e2e:mail:${message.to}`;
    const previous = await env.CACHE.get<{ count: number }>(key, 'json');
    await env.CACHE.put(key, JSON.stringify({ code, count: (previous?.count ?? 0) + 1 }), { expirationTtl: 600 });
    return { messageId: `local-${crypto.randomUUID()}` };
  } };
  return worker.fetch(request, { ...env, EMAIL: email as unknown as SendEmail }, context);
} };
