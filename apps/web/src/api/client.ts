import { captureSessionIdentity, isProtectedApiPath, notifySessionExpiry } from './session-expiry.js';
import type { ApiClientErrorKind, ApiClientOptions, ApiErrorCode, ApiMethod, ApiQuery, ApiRequestOptions, JsonValue, SuccessEnvelope } from './types.js';

const messages: Record<ApiErrorCode, string> = {
  invalid_request: '请求参数无效。', unauthorized: '请登录后重试。', insufficient_balance: '余额不足。',
  forbidden: '没有执行此操作的权限。', not_found: '请求的资源不存在。', conflict: '数据已发生变化，请刷新后重试。',
  payload_too_large: '提交的数据过大。', rate_limited: '请求过于频繁，请稍后重试。',
  internal_error: '服务暂时无法完成请求。', service_unavailable: '服务暂不可用，请稍后重试。',
};

export class ApiClientError extends Error {
  readonly kind: ApiClientErrorKind;
  readonly status: number | null;
  readonly code: string;
  readonly request_id: string | null;
  constructor(kind: ApiClientErrorKind, message: string, options: { status?: number; code?: string; request_id?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiClientError'; this.kind = kind; this.status = options.status ?? null;
    this.code = options.code ?? kind; this.request_id = options.request_id ?? null;
  }
}

/** CSRF cookie is intentionally readable; the session cookie remains HttpOnly. */
export function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const name = '__Host-sub2api_csrf=';
  const cookie = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(name));
  if (!cookie) return null;
  try { return decodeURIComponent(cookie.slice(name.length)); } catch { return null; }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validRequestId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u0020\u007f]/u.test(value);

function urlFor(path: string, query?: ApiQuery): string {
  // Reject ambiguity/traversal before URL normalization can leave the API prefix.
  if (!(path === '/api/v1' || path.startsWith('/api/v1/')) || /[?#\\\u0000-\u0020]/u.test(path)) {
    throw new ApiClientError('request', '管理 API 路径无效。');
  }
  const modelParameter = /^\/api\/v1\/admin\/models\/[^/]+(?:\/mappings(?:\/[^/]+\/(?:chat|responses|messages))?)?$/u.test(path);
  for (const [index, part] of path.split('/').entries()) {
    let decoded: string; try { decoded = decodeURIComponent(part); } catch { throw new ApiClientError('request', '管理 API 路径编码无效。'); }
    // Only the public model ID parameter may contain a once-encoded slash.
    // Hono splits the route before decoding this parameter. Never allow an
    // encoded slash in the API prefix, channel ID, suffix or unrelated routes.
    const modelId = modelParameter && index === 5;
    if (decoded.includes('%') || /[\\\u0000-\u0020\u007f]/u.test(decoded)
      || decoded.split('/').some(segment => segment === '.' || segment === '..')
      || (decoded.includes('/') && (!modelId || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u.test(decoded)
        || decoded.split('/').some(segment => segment.length === 0)))) throw new ApiClientError('request', '管理 API 路径无效。');
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new ApiClientError('request', '查询参数无效。');
      search.append(key, String(item));
    }
  }
  const encoded = search.toString(); return encoded ? `${path}?${encoded}` : path;
}
function failedTransport(cause: unknown, signal?: AbortSignal): ApiClientError {
  return signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')
    ? new ApiClientError('aborted', '请求已取消。', { cause })
    : new ApiClientError('network', '网络请求失败，请检查连接后重试。', { cause });
}

/** No retries: repeating a management write could create a duplicate operation. */
export function createApiClient(options: ApiClientOptions = {}) {
  const fetcher = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const csrfToken = options.getCsrfToken ?? readCsrfCookie;
  async function request<T = unknown>(path: string, input: ApiRequestOptions<T> = {}): Promise<SuccessEnvelope<T>> {
    const sessionIdentity = captureSessionIdentity();
    const method = input.method ?? 'GET';
    const url = urlFor(path, input.query);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new ApiClientError('request', 'HTTP 方法无效。');
    if (method === 'GET' && input.body !== undefined) throw new ApiClientError('request', '读取请求不能携带请求体。');
    const headers = new Headers({ Accept: 'application/json' });
    if (input.idempotencyKey !== undefined) {
      if (method === 'GET' || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length > 128
          || input.idempotencyKey.trim() !== input.idempotencyKey
          || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.idempotencyKey)) {
        throw new ApiClientError('request', '幂等操作标识无效。');
      }
      headers.set('Idempotency-Key', input.idempotencyKey);
    }
    if (method !== 'GET') {
      let token: string | null | undefined;
      try { token = await csrfToken(); } catch (cause) { throw new ApiClientError('request', '无法读取请求验证令牌。', { cause }); }
      if (token !== undefined && token !== null && token !== '') {
        if (token.length > 4096 || /[\u0000-\u0020\u007f]/u.test(token)) throw new ApiClientError('request', '请求验证令牌无效。');
        headers.set('X-CSRF-Token', token);
      } else if (input.csrf !== 'if-available') throw new ApiClientError('request', '缺少请求验证令牌，请刷新页面后重试。', { code: 'csrf_missing' });
    }
    let body: string | undefined;
    if (input.body !== undefined) {
      try { body = JSON.stringify(input.body); } catch (cause) { throw new ApiClientError('request', '请求体不是有效 JSON。', { cause }); }
      headers.set('Content-Type', 'application/json');
    }
    let response: Response;
    try { response = await fetcher(url, { method, headers, credentials: 'same-origin', redirect: 'error',
      ...(body === undefined ? {} : { body }), ...(input.signal === undefined ? {} : { signal: input.signal }) });
    } catch (cause) { throw failedTransport(cause, input.signal); }
    if (response.status === 401 && isProtectedApiPath(path)) notifySessionExpiry(sessionIdentity, path);
    const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (mediaType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/u.test(mediaType)) {
      throw new ApiClientError('invalid_response', '服务返回了非 JSON 响应。', { status: response.status, code: 'non_json_response' });
    }
    let payload: unknown;
    try { payload = await response.json(); } catch (cause) {
      if (input.signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')) throw failedTransport(cause, input.signal);
      throw new ApiClientError('invalid_response', '服务返回了无法解析的 JSON 响应。', { status: response.status, cause });
    }
    const requestId = object(payload) && validRequestId(payload.request_id) ? payload.request_id : undefined;
    const details = { status: response.status, ...(requestId === undefined ? {} : { request_id: requestId }) };
    if (object(payload) && object(payload.error) && typeof payload.error.code === 'string' && typeof payload.error.message === 'string' && requestId !== undefined) {
      const code = payload.error.code;
      if (response.ok || Object.hasOwn(payload, 'data')) throw new ApiClientError('invalid_response', '服务返回了不一致的响应格式。', details);
      const message = Object.hasOwn(messages, code) ? messages[code as ApiErrorCode] : '请求未能完成，请稍后重试。';
      throw new ApiClientError('api', message, { ...details, code });
    }
    if (!response.ok) throw new ApiClientError('http', `请求失败（HTTP ${response.status}）。`, details);
    if (!object(payload) || requestId === undefined || !Object.hasOwn(payload, 'data') || Object.hasOwn(payload, 'error')) {
      throw new ApiClientError('invalid_response', '服务返回了无效的管理 API 响应格式。', details);
    }
    let data: T;
    try { data = input.decode ? input.decode(payload.data) : payload.data as T; } catch (cause) {
      throw new ApiClientError('invalid_response', '服务返回的数据结构无效。', { ...details, cause });
    }
    return { data, request_id: requestId };
  }
  const write = (method: Exclude<ApiMethod, 'GET'>) => <T = unknown>(path: string, body?: JsonValue, input: Omit<ApiRequestOptions<T>, 'method' | 'body'> = {}) =>
    request<T>(path, { ...input, method, ...(body === undefined ? {} : { body }) });
  return Object.freeze({ request, get: <T = unknown>(path: string, input: Omit<ApiRequestOptions<T>, 'method' | 'body'> = {}) => request<T>(path, { ...input, method: 'GET' }),
    post: write('POST'), put: write('PUT'), patch: write('PATCH'), delete: write('DELETE') });
}
export const apiClient = createApiClient();
