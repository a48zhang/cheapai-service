import type { ApiClientErrorKind, ApiErrorCode } from './types.js';

export const apiErrorMessages: Readonly<Record<ApiErrorCode, string>> = {
  invalid_request: '请求参数无效。',
  unauthorized: '请登录后重试。',
  insufficient_balance: '余额不足。',
  forbidden: '没有执行此操作的权限。',
  not_found: '请求的资源不存在。',
  conflict: '数据已发生变化，请刷新后重试。',
  payload_too_large: '提交的数据过大。',
  rate_limited: '请求过于频繁，请稍后重试。',
  internal_error: '服务暂时无法完成请求。',
  service_unavailable: '服务暂不可用，请稍后重试。',
};

export interface ApiClientErrorOptions {
  readonly status?: number;
  readonly code?: string;
  readonly request_id?: string;
  readonly cause?: unknown;
}

export class ApiClientError extends Error {
  readonly kind: ApiClientErrorKind;
  readonly status: number | null;
  readonly code: string;
  readonly request_id: string | null;

  constructor(kind: ApiClientErrorKind, message: string, options: ApiClientErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiClientError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.code = options.code ?? kind;
    this.request_id = options.request_id ?? null;
  }
}
