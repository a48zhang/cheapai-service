const answer = 'Local fixture answer';
const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15,
  input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
export function body(protocol: string, model: string, id: string): Record<string, unknown> {
  if (protocol === 'chat') return { id, object: 'chat.completion', model, created: 1,
    choices: [{ index: 0, message: { role: 'assistant', content: answer, annotations: [] }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } };
  if (protocol === 'responses') return { id, object: 'response', model, created_at: 1, status: 'completed',
    output: [{ id: `${id}_item`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] }], usage };
  return { id, type: 'message', model, role: 'assistant', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}
export function stream(protocol: string, model: string, id: string): Response {
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

