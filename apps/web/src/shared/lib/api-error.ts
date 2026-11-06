import { ApiClientError } from '@cheapai/api-client/errors';

/** Add actionable context without discarding transport diagnostics or the original cause. */
export function withErrorContext(cause: unknown, message: string): Error {
  if (cause instanceof ApiClientError) {
    return new ApiClientError(cause.kind, message, {
      ...(cause.status === null ? {} : { status: cause.status }),
      code: cause.code,
      ...(cause.request_id === null ? {} : { request_id: cause.request_id }),
      details: cause.details,
      cause,
    });
  }
  return new Error(message, { cause });
}

/** A single representation for API errors and domain failures, displayed and copied verbatim. */
export function errorDetails(error: unknown): string {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && 'message' in current && !seen.has(current)) {
    seen.add(current);
    lines.push(`${seen.size === 1 ? '具体原因' : '原因'}：${String(current.message)}`);
    if ('status' in current && current.status != null) lines.push(`HTTP 状态：${current.status}`);
    if ('code' in current && current.code) lines.push(`错误码：${current.code}`);
    if ('request_id' in current && current.request_id)
      lines.push(`请求编号：${current.request_id}`);
    if ('details' in current && current.details !== undefined)
      lines.push(`错误详情：${JSON.stringify(current.details, null, 2)}`);
    current = 'cause' in current ? current.cause : undefined;
  }
  if (current !== undefined && !seen.has(current)) lines.push(`原因：${String(current)}`);
  return lines.join('\n');
}
