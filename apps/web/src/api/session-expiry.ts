/** Transport-only bridge. It has no dependency on a store or router. */
export interface SessionIdentity {
  readonly generation: number;
  readonly userId: string;
}
export interface SessionExpiryNotice extends SessionIdentity { readonly path: string }
let identity: () => SessionIdentity | null = () => null;
let listener: (notice: SessionExpiryNotice) => void = () => undefined;
export function bindSessionExpiry(source: () => SessionIdentity | null, onExpiry: (notice: SessionExpiryNotice) => void): () => void {
  identity = source; listener = onExpiry;
  return () => { if (identity === source) { identity = () => null; listener = () => undefined; } };
}
export function captureSessionIdentity(): SessionIdentity | null { return identity(); }
export function notifySessionExpiry(snapshot: SessionIdentity | null, path: string): void {
  if (!snapshot) return;
  try { listener({ ...snapshot, path }); } catch { /* Navigation must not replace the HTTP failure. */ }
}
export function isProtectedApiPath(path: string): boolean {
  // Public authentication failures must never invalidate an existing identity.
  return path !== '/api/v1/settings/public' && (!path.startsWith('/api/v1/auth/')
    || path === '/api/v1/auth/me' || path === '/api/v1/auth/logout');
}
