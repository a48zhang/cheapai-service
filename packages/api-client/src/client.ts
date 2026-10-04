import { requestIdSchema } from '@cheapai/contracts/common';
import { ApiClientError, apiErrorMessages } from './errors.js';
import { readCsrfCookie } from './csrf.js';
import { apiUrlFor, isProtectedApiPath } from './url.js';
import type {
  ApiClient,
  ApiClientOptions,
  ApiErrorCode,
  ApiMethod,
  ApiRequestOptions,
  JsonInput,
  SessionIdentity,
  SuccessEnvelope,
} from './types.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function failedTransport(cause: unknown, signal?: AbortSignal): ApiClientError {
  return signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')
    ? new ApiClientError('aborted', '请求已取消。', { cause })
    : new ApiClientError('network', '网络请求失败，请检查连接后重试。', { cause });
}

/**
 * Create an injectable management API transport. Writes are sent once: callers
 * must explicitly reuse the same idempotency key when recovering an uncertain result.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetcher =
    options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const csrfToken = options.getCsrfToken ?? readCsrfCookie;

  async function request<T = unknown>(
    path: string,
    input: ApiRequestOptions<T> = {},
  ): Promise<SuccessEnvelope<T>> {
    let sessionIdentity: SessionIdentity | null = null;
    try {
      sessionIdentity = options.captureIdentity?.() ?? null;
    } catch {
      // Identity is advisory request context. A store read must not suppress transport.
    }

    const method = input.method ?? 'GET';
    const url = apiUrlFor(path, input.query);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      throw new ApiClientError('request', 'HTTP 方法无效。');
    }
    if (method === 'GET' && input.body !== undefined) {
      throw new ApiClientError('request', '读取请求不能携带请求体。');
    }

    const headers = new Headers({ Accept: 'application/json' });
    if (input.idempotencyKey !== undefined) {
      if (
        method === 'GET' ||
        typeof input.idempotencyKey !== 'string' ||
        input.idempotencyKey.length > 128 ||
        input.idempotencyKey.trim() !== input.idempotencyKey ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.idempotencyKey)
      ) {
        throw new ApiClientError('request', '幂等操作标识无效。');
      }
      headers.set('Idempotency-Key', input.idempotencyKey);
    }

    if (method !== 'GET') {
      let token: string | null | undefined;
      try {
        token = await csrfToken();
      } catch (cause) {
        throw new ApiClientError('request', '无法读取请求验证令牌。', { cause });
      }
      if (token !== undefined && token !== null && token !== '') {
        if (token.length > 4096 || /[\u0000-\u0020\u007f]/u.test(token)) {
          throw new ApiClientError('request', '请求验证令牌无效。');
        }
        headers.set('X-CSRF-Token', token);
      } else if (input.csrf !== 'if-available') {
        throw new ApiClientError('request', '缺少请求验证令牌，请刷新页面后重试。', {
          code: 'csrf_missing',
        });
      }
    }

    let body: string | undefined;
    if (input.body !== undefined) {
      try {
        body = JSON.stringify(input.body);
      } catch (cause) {
        throw new ApiClientError('request', '请求体不是有效 JSON。', { cause });
      }
      headers.set('Content-Type', 'application/json');
    }

    let response: Response;
    try {
      response = await fetcher(url, {
        method,
        headers,
        credentials: 'same-origin',
        redirect: 'error',
        ...(body === undefined ? {} : { body }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (cause) {
      throw failedTransport(cause, input.signal);
    }

    // Notify before content-type or body parsing so HTML proxy 401s still expire the captured session.
    if (response.status === 401 && sessionIdentity && isProtectedApiPath(path)) {
      try {
        options.onUnauthorized?.(sessionIdentity, path);
      } catch {
        // Session/navigation errors must not replace the HTTP response failure.
      }
    }

    const mediaType =
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (mediaType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/u.test(mediaType)) {
      throw new ApiClientError('invalid_response', '服务返回了非 JSON 响应。', {
        status: response.status,
        code: 'non_json_response',
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      if (input.signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')) {
        throw failedTransport(cause, input.signal);
      }
      throw new ApiClientError('invalid_response', '服务返回了无法解析的 JSON 响应。', {
        status: response.status,
        cause,
      });
    }

    const parsedRequestId = isObject(payload)
      ? requestIdSchema.safeParse(payload.request_id)
      : null;
    const requestId = parsedRequestId?.success ? parsedRequestId.data : undefined;
    const details = {
      status: response.status,
      ...(requestId === undefined ? {} : { request_id: requestId }),
    };
    if (
      isObject(payload) &&
      isObject(payload.error) &&
      typeof payload.error.code === 'string' &&
      typeof payload.error.message === 'string' &&
      requestId !== undefined
    ) {
      const code = payload.error.code;
      if (response.ok || Object.hasOwn(payload, 'data')) {
        throw new ApiClientError('invalid_response', '服务返回了不一致的响应格式。', details);
      }
      const message = Object.hasOwn(apiErrorMessages, code)
        ? apiErrorMessages[code as ApiErrorCode]
        : '请求未能完成，请稍后重试。';
      throw new ApiClientError('api', message, { ...details, code });
    }
    if (!response.ok) {
      throw new ApiClientError('http', `请求失败（HTTP ${response.status}）。`, details);
    }
    if (
      !isObject(payload) ||
      requestId === undefined ||
      !Object.hasOwn(payload, 'data') ||
      Object.hasOwn(payload, 'error')
    ) {
      throw new ApiClientError('invalid_response', '服务返回了无效的管理 API 响应格式。', details);
    }

    let data: T;
    try {
      data = input.decode ? input.decode(payload.data) : (payload.data as T);
    } catch (cause) {
      throw new ApiClientError('invalid_response', '服务返回的数据结构无效。', {
        ...details,
        cause,
      });
    }
    return { data, request_id: requestId };
  }

  const write =
    (method: Exclude<ApiMethod, 'GET'>) =>
    <T = unknown>(
      path: string,
      body?: JsonInput,
      input: Omit<ApiRequestOptions<T>, 'method' | 'body'> = {},
    ) =>
      request<T>(path, { ...input, method, ...(body === undefined ? {} : { body }) });

  return Object.freeze({
    request,
    get: <T = unknown>(path: string, input: Omit<ApiRequestOptions<T>, 'method' | 'body'> = {}) =>
      request<T>(path, { ...input, method: 'GET' }),
    post: write('POST'),
    put: write('PUT'),
    patch: write('PATCH'),
    delete: write('DELETE'),
  });
}
