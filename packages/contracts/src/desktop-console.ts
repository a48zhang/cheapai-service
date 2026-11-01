/** The native transport serves personal console operations, never arbitrary URLs or admin APIs. */
export function isDesktopConsoleRequest(method: string, path: string): boolean {
  if (!path.startsWith('/api/v1/') || /[\\#\u0000-\u0020]/u.test(path)) return false;
  const url = new URL(path, 'https://cheapai.dev');
  if (url.pathname !== path.split('?')[0]) return false;
  const pathname = url.pathname;
  if (method === 'GET')
    return [
      /^\/api\/v1\/(?:auth\/me|settings\/public|catalog\/(?:models|groups)|account\/(?:balance|key-groups))$/u,
      /^\/api\/v1\/keys(?:\/[^/]+)?$/u,
      /^\/api\/v1\/usage\/requests(?:\/[^/]+)?$/u,
      /^\/api\/v1\/billing\/entries$/u,
      /^\/api\/v1\/images\/(?:models|generations(?:\/[^/]+(?:\/content)?)?)$/u,
    ].some((pattern) => pattern.test(pathname));
  if (method === 'POST')
    return (
      pathname === '/api/v1/keys' ||
      pathname === '/api/v1/images/generations' ||
      /^\/api\/v1\/keys\/[^/]+\/revoke$/u.test(pathname)
    );
  return method === 'PATCH' && /^\/api\/v1\/keys\/[^/]+$/u.test(pathname);
}

export interface DesktopConsoleRequest {
  accountId: string;
  method: string;
  path: string;
  body?: string;
  idempotencyKey?: string;
}
export interface DesktopConsoleResponse {
  status: number;
  contentType: string;
  body: string;
  encoding: 'utf8' | 'base64';
}

export function isDesktopConsolePayload(value: unknown): value is DesktopConsoleRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.accountId === 'string' &&
    request.accountId.length > 0 &&
    typeof request.method === 'string' &&
    typeof request.path === 'string' &&
    isDesktopConsoleRequest(request.method, request.path) &&
    (request.body === undefined || typeof request.body === 'string') &&
    (request.idempotencyKey === undefined ||
      (typeof request.idempotencyKey === 'string' && !/[\r\n]/u.test(request.idempotencyKey)))
  );
}
