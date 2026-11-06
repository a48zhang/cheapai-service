/** Independent loopback HTTP supplier. Only generated local acceptance traffic belongs here. */
import { createServer } from 'node:http';
import { appendFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { body, stream } from '../tests/helpers/provider-fixture.ts';
const calls = [];
const imageBase64 = (await readFile(new URL('../tests/helpers/mock-image.png', import.meta.url))).toString('base64');
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/__calls' && request.headers['x-e2e-control'] === process.env.E2E_CONTROL_TOKEN) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ calls })); return;
    }
    const protocol = request.url === '/v1/chat/completions' ? 'chat' : request.url === '/v1/responses' ? 'responses' : request.url === '/v1/messages' ? 'messages' : request.url === '/v1/images/generations' ? 'images' : null;
    if (!protocol || request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    const id = `mock_${randomUUID()}`;
    const failure = payload.model === 'fixture-rejected';
    const entry = { id, path: request.url, protocol, model: payload.model, stream: payload.stream === true,
      platformCredentialLeaked: Object.values(request.headers).some(value => String(value).includes('s2a_key_')),
      authorized: Boolean(request.headers.authorization || request.headers['x-api-key']), body: payload, status: failure ? 429 : 200 };
    calls.push(entry);
    if (process.env.E2E_REQUEST_LOG) await appendFile(process.env.E2E_REQUEST_LOG, JSON.stringify(entry) + '\n');
    response.setHeader('x-request-id', id);
    if (failure) {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Mock supplier capacity reached', type: 'rate_limit_error', code: 'mock_capacity' } })); return;
    }
    const result = protocol === 'images' ? Response.json({ data: [{ b64_json: imageBase64 }] })
      : payload.stream ? stream(protocol, payload.model, id) : Response.json(body(protocol, payload.model, id));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    for await (const chunk of result.body) {
      response.write(chunk);
      if (payload.stream) await new Promise(resolve => setTimeout(resolve, 25));
    }
    response.end();
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
server.listen(0, '127.0.0.1', () => process.send?.({ baseURL: `http://127.0.0.1:${server.address().port}` }));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
