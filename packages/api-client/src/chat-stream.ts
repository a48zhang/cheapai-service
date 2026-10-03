import { requestIdSchema } from '@cheapai/contracts/common';
import {
  chatDeltaEventSchema,
  chatDoneEventSchema,
  chatErrorEventSchema,
  chatMetaEventSchema,
  decodeChatReplay,
} from '@cheapai/contracts/chat';
import type {
  ChatErrorEvent,
  ChatSendResult,
  ChatStreamHandlers,
} from '@cheapai/contracts/chat';
import { ApiClientError } from './errors.js';
import { readCsrfCookie } from './csrf.js';
import { apiUrlFor, isProtectedApiPath } from './url.js';
import type { ApiClientOptions, SessionIdentity } from './types.js';

export interface ChatStreamOptions extends ApiClientOptions {
  readonly handlers?: ChatStreamHandlers;
  readonly signal?: AbortSignal;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object' && !Array.isArray(value);

function transportError(cause: unknown, signal?: AbortSignal): ApiClientError {
  return signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')
    ? new ApiClientError('aborted', '请求已取消。', { cause })
    : new ApiClientError('network', '网络请求失败，请检查连接后重试。', { cause });
}

function parseEventFrame(frame: string): { readonly event: string; readonly data: unknown } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of frame.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5));
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) as unknown };
  } catch (cause) {
    throw new ApiClientError('invalid_response', '流式响应数据无法解析。', { cause });
  }
}

function nextSseFrame(buffer: string): { readonly frame: string; readonly rest: string } | null {
  // EventSource accepts LF, CRLF, and mixed line endings.
  const boundary = /\r?\n\r?\n/u.exec(buffer);
  if (!boundary || boundary.index === undefined) return null;
  return {
    frame: buffer.slice(0, boundary.index),
    rest: buffer.slice(boundary.index + boundary[0].length),
  };
}

async function readSse(response: Response, handlers: ChatStreamHandlers, signal?: AbortSignal): Promise<ChatSendResult> {
  if (!response.body) {
    throw new ApiClientError('invalid_response', '服务未返回流式响应。', { status: response.status, code: 'empty_stream' });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ChatSendResult | undefined;

  const consume = async (frame: string): Promise<void> => {
    const parsed = parseEventFrame(frame);
    if (!parsed) return;
    if (parsed.event === 'meta') {
      const event = chatMetaEventSchema.safeParse(parsed.data);
      if (!event.success) throw new ApiClientError('invalid_response', '流式响应数据结构无效。');
      await handlers.onMeta?.(event.data);
    } else if (parsed.event === 'delta') {
      const event = chatDeltaEventSchema.safeParse(parsed.data);
      if (!event.success) throw new ApiClientError('invalid_response', '流式响应数据结构无效。');
      await handlers.onDelta?.(event.data.text);
    } else if (parsed.event === 'done') {
      const event = chatDoneEventSchema.safeParse(parsed.data);
      if (!event.success) throw new ApiClientError('invalid_response', '流式响应数据结构无效。');
      await handlers.onDone?.(event.data.message, event.data.billingStatus);
      result = {
        kind: 'stream',
        message: event.data.message,
        ...(event.data.billingStatus === undefined ? {} : { billingStatus: event.data.billingStatus }),
      };
    } else if (parsed.event === 'error') {
      const event = chatErrorEventSchema.safeParse(parsed.data);
      if (!event.success) throw new ApiClientError('invalid_response', '流式响应数据结构无效。');
      const error: ChatErrorEvent = event.data;
      await handlers.onError?.(error);
      throw new ApiClientError('api', error.message, { status: response.status, code: error.code });
    }
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        if (signal?.aborted) throw transportError(new Error('AbortError'), signal);
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let next = nextSseFrame(buffer);
      while (next) {
        buffer = next.rest;
        await consume(next.frame);
        if (result) {
          await reader.cancel();
          return result;
        }
        next = nextSseFrame(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await consume(buffer);
    if (result) return result;
    throw new ApiClientError('invalid_response', '流式响应提前结束。', { status: response.status, code: 'incomplete_stream' });
  } catch (cause) {
    if (cause instanceof ApiClientError) throw cause;
    if (signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
      throw transportError(cause, signal);
    }
    throw cause;
  } finally {
    reader.releaseLock();
  }
}

async function responseError(response: Response): Promise<never> {
  let code = 'http_' + response.status;
  let message = '请求失败（HTTP ' + response.status + '）。';
  try {
    const payload: unknown = await response.clone().json();
    if (isObject(payload) && isObject(payload.error)
      && typeof payload.error.code === 'string' && payload.error.code.length > 0 && payload.error.code.length <= 128
      && typeof payload.error.message === 'string' && payload.error.message.length > 0 && payload.error.message.length <= 4096) {
      code = payload.error.code;
      message = payload.error.message;
      const parsedRequestId = requestIdSchema.safeParse(payload.request_id);
      throw new ApiClientError('api', message, {
        status: response.status,
        code,
        ...(parsedRequestId.success ? { request_id: parsedRequestId.data } : {}),
      });
    }
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
  }
  throw new ApiClientError('http', message, { status: response.status, code });
}

/**
 * Send a chat request whose successful response may be either an SSE stream
 * or an idempotent replay envelope. Aborting the signal cancels the fetch; the
 * caller should reload conversation detail because the server has no stop route.
 */
export async function sendChatStream(
  path: string,
  body: Readonly<Record<string, unknown>>,
  options: ChatStreamOptions = {},
): Promise<ChatSendResult> {
  const url = apiUrlFor(path);
  const fetcher = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  let identity: SessionIdentity | null = null;
  try {
    identity = options.captureIdentity?.() ?? null;
  } catch {
    // Identity is advisory request context.
  }

  let token: string | null | undefined;
  try {
    token = await (options.getCsrfToken ?? readCsrfCookie)();
  } catch (cause) {
    throw new ApiClientError('request', '无法读取请求验证令牌。', { cause });
  }
  if (token === null || token === undefined || token === '') {
    throw new ApiClientError('request', '缺少请求验证令牌，请刷新页面后重试。', { code: 'csrf_missing' });
  }
  if (token.length > 4096 || /[\u0000-\u0020\u007f]/u.test(token)) {
    throw new ApiClientError('request', '请求验证令牌无效。');
  }

  const headers = new Headers({
    Accept: 'text/event-stream, application/json',
    'Content-Type': 'application/json',
    'X-CSRF-Token': token,
  });
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      redirect: 'error',
      body: JSON.stringify(body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    throw transportError(cause, options.signal);
  }

  if (response.status === 401 && identity && isProtectedApiPath(path)) {
    try {
      options.onUnauthorized?.(identity, path);
    } catch {
      // Session/navigation errors must not replace the response failure.
    }
  }
  if (!response.ok) return responseError(response);

  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType === 'text/event-stream') return readSse(response, options.handlers ?? {}, options.signal);
  if (mediaType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/u.test(mediaType)) {
    throw new ApiClientError('invalid_response', '服务返回了无法识别的聊天响应。', { status: response.status, code: 'non_json_response' });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    if (options.signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
      throw transportError(cause, options.signal);
    }
    throw new ApiClientError('invalid_response', '服务返回了无法解析的聊天响应。', { status: response.status, cause });
  }
  if (!isObject(payload) || !Object.hasOwn(payload, 'data')) {
    throw new ApiClientError('invalid_response', '服务返回了无效的聊天响应格式。', { status: response.status });
  }
  return decodeChatReplay(payload.data);
}
