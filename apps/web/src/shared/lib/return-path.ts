/** Accept only local app paths; never a URL, scheme-relative URL or API path. */
export function safeReturnPath(value: unknown, fallback = '/'): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u0020\u007f]/u.test(value)
  )
    return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  if (decoded.startsWith('//') || /[\\\u0000-\u0020\u007f]/u.test(decoded)) return fallback;
  // Normalize dot segments before checking application-only destinations.
  let path: string;
  try {
    path = new URL(decoded, 'https://app.invalid').pathname;
  } catch {
    return fallback;
  }
  if (
    path === '/api' ||
    path.startsWith('/api/') ||
    path === '/v1' ||
    path.startsWith('/v1/') ||
    path === '/login' ||
    path === '/session-unavailable'
  )
    return fallback;
  return value;
}
