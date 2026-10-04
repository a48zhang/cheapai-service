import type { ApiQuery } from './types.js';
import { ApiClientError } from './errors.js';

/**
 * Validate an internal management API path before the URL implementation can
 * normalize traversal segments or resolve an external origin.
 */
export function apiUrlFor(path: string, query?: ApiQuery): string {
  if (!(path === '/api/v1' || path.startsWith('/api/v1/')) || /[?#\\\u0000-\u0020]/u.test(path)) {
    throw new ApiClientError('request', '管理 API 路径无效。');
  }
  const modelParameter =
    /^\/api\/v1\/admin\/models\/[^/]+(?:\/mappings(?:\/[^/]+\/(?:chat|responses|messages))?)?$/u.test(
      path,
    );
  for (const [index, part] of path.split('/').entries()) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      throw new ApiClientError('request', '管理 API 路径编码无效。');
    }
    // Only the public model ID parameter may contain a once-encoded slash.
    // Hono splits the route before decoding this parameter.
    const modelId = modelParameter && index === 5;
    if (
      decoded.includes('%') ||
      /[\\\u0000-\u0020\u007f]/u.test(decoded) ||
      decoded.split('/').some((segment) => segment === '.' || segment === '..') ||
      (decoded.includes('/') &&
        (!modelId ||
          !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u.test(decoded) ||
          decoded.split('/').some((segment) => segment.length === 0)))
    ) {
      throw new ApiClientError('request', '管理 API 路径无效。');
    }
  }

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'number' && !Number.isFinite(item)) {
        throw new ApiClientError('request', '查询参数无效。');
      }
      search.append(key, String(item));
    }
  }
  const encoded = search.toString();
  return encoded ? `${path}?${encoded}` : path;
}

/** Public authentication failures must not invalidate an existing identity. */
export function isProtectedApiPath(path: string): boolean {
  return (
    path !== '/api/v1/settings/public' &&
    (!path.startsWith('/api/v1/auth/') ||
      path === '/api/v1/auth/me' ||
      path === '/api/v1/auth/logout')
  );
}
