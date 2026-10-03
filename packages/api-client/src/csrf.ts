/** The CSRF cookie remains readable; the session cookie remains HttpOnly. */
export function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const name = '__Host-sub2api_csrf=';
  const cookie = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(name));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.slice(name.length));
  } catch {
    return null;
  }
}
