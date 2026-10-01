import type { MiddlewareHandler } from 'hono';
import { ApiError, apiError, createRequestId } from '../http';

export const CSRF_COOKIE_NAME = '__Host-sub2api_csrf';
export const CSRF_HEADER_NAME = 'X-CSRF-Token';
const tokenPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const cookieAttributes = 'Secure; Path=/; SameSite=Strict';

export interface IssuedCsrfToken {
  token: string;
  setCookie: string;
  cacheControl: 'no-store';
}

function validToken(value: unknown): value is string {
  // Length also prevents JavaScript's $ anchor from accepting a final newline.
  return typeof value === 'string' && value.length === 43 && tokenPattern.test(value);
}
function forbidden(): never { throw new ApiError('forbidden'); }

function readCsrfCookie(header: string | null): string | null {
  if (header === null) return null;
  if (typeof header !== 'string' || header.length > 8192 || /[\r\n\u0000]/.test(header)) forbidden();
  let found: string | null = null;
  for (const segment of header.split(';')) {
    const part = segment.replace(/^[ \t]+/g, '');
    const separator = part.indexOf('=');
    const name = separator < 0 ? part : part.slice(0, separator);
    if (name.trim() !== CSRF_COOKIE_NAME) continue;
    if (name !== CSRF_COOKIE_NAME || separator < 0 || found !== null) forbidden();
    const value = part.slice(separator + 1);
    // No decoding, quoting, padding, or alternate encodings of the nonce.
    if (!validToken(value)) forbidden();
    found = value;
  }
  return found;
}

/** Public settings/bootstrap may call this before login. Apply BOTH returned
 * headers; a token-bearing response must not be cached. The cookie deliberately
 * has no HttpOnly attribute so same-origin browser code can echo it in a header.
 * Reuse a valid nonce instead of invalidating other tabs on each settings read.
 * This is CSRF protection using host-prefix cookies + Origin, not XSS protection.
 */
export function issueCsrfToken(cookieHeader: string | null = null): IssuedCsrfToken {
  let token = readCsrfCookie(cookieHeader);
  if (token === null) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return { token, setCookie: `${CSRF_COOKIE_NAME}=${token}; ${cookieAttributes}`, cacheControl: 'no-store' };
}

function configuredOrigin(trustedOrigin: string): string {
  try {
    const origin = new URL(trustedOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.origin !== trustedOrigin) throw new Error();
    return origin.origin;
  } catch {
    // Invalid trusted configuration is a startup/caller error, never derived
    // from incoming Host, forwarding headers, Origin, or request content.
    throw new TypeError('trustedOrigin must be a canonical HTTPS origin.');
  }
}

function isManagementWrite(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (path === '/api' || path.startsWith('/api/')) && !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase());
}

function validate(request: Request, trustedOrigin: string): void {
  if (!isManagementWrite(request)) return;
  if (request.headers.get('Origin') !== trustedOrigin) forbidden();
  const cookie = readCsrfCookie(request.headers.get('Cookie'));
  const header = request.headers.get(CSRF_HEADER_NAME);
  if (cookie === null || !validToken(header)) forbidden();
  // Both values have already been validated as equal-length canonical ASCII.
  const encoder = new TextEncoder();
  if (!crypto.subtle.timingSafeEqual(encoder.encode(cookie), encoder.encode(header))) forbidden();
}

/** Only /api management writes are protected, including anonymous login/register.
 * /v1 platform-key traffic has a separate authentication boundary.
 */
export function validateCsrfRequest(request: Request, trustedOrigin: string): void {
  validate(request, configuredOrigin(trustedOrigin));
}

/** Configure once from trusted server settings. Session middleware may run later:
 * a login request must be able to pass CSRF checks before it owns a session.
 */
export function requireCsrf(trustedOrigin: string): MiddlewareHandler {
  const origin = configuredOrigin(trustedOrigin);
  return async (context, next) => {
    try {
      validate(context.req.raw, origin);
    } catch (error) {
      const existing = context.get('requestId');
      const requestId = typeof existing === 'string' ? existing : createRequestId();
      return apiError(error instanceof ApiError ? error : new ApiError('service_unavailable'), requestId);
    }
    await next();
  };
}
