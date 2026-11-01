import type { DesktopConsoleResponse } from '@cheapai/contracts/desktop-console';

const channel = 'cheapai-console';
const targetOrigin = window.location.origin === 'null' ? '*' : window.location.origin;

/** Only the containing local desktop window can answer this frame's requests. */
export function consoleBridge(
  action: 'request' | 'download',
  payload?: unknown,
  signal?: AbortSignal,
): Promise<DesktopConsoleResponse> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, response?: DesktopConsoleResponse) => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(response!);
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== window.location.origin) return;
      const message = event.data;
      if (message?.channel !== channel || message.id !== id || message.type !== 'response') return;
      if (message.error) finish(new Error('桌面服务请求未完成。'));
      else finish(undefined, message.response);
    };
    const abort = () => finish(new DOMException('Request aborted', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('桌面服务请求超时。')), 190_000);
    window.addEventListener('message', receive);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    window.parent.postMessage({ channel, type: action, id, payload }, targetOrigin);
  });
}

export const consoleFetch: typeof fetch = async (input, init) => {
  const request = new Request(
    typeof input === 'string' ? new URL(input, 'https://cheapai.dev') : input,
    init,
  );
  const url = new URL(request.url);
  const result = await consoleBridge(
    'request',
    {
      method: request.method,
      path: url.pathname + url.search,
      ...(request.method === 'GET' || request.method === 'HEAD'
        ? {}
        : { body: await request.text() }),
      ...(request.headers.has('Idempotency-Key')
        ? { idempotencyKey: request.headers.get('Idempotency-Key') }
        : {}),
    },
    request.signal,
  );
  const body =
    result.encoding === 'base64'
      ? Uint8Array.from(atob(result.body), (char) => char.charCodeAt(0))
      : result.body;
  return new Response(body, {
    status: result.status,
    headers: { 'Content-Type': result.contentType },
  });
};
export function leaveConsole(action: 'workspace' | 'login') {
  window.parent.postMessage({ channel, type: action }, targetOrigin);
}
