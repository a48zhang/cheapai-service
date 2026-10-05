/* Classic, blocking head script and module fallback share one implementation.
 * No account data, network access, or inline script/CSP exceptions are needed. */
(() => {
  if (window.__cheapaiTheme) return;
  const key = 'cheapai.appearance.v1';
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  /** @param {unknown} value @returns {import('./types').ThemePreference} */
  const parse = (value) => (value === 'light' || value === 'dark' ? value : 'system');
  /** @type {import('./types').ThemePreference} */
  let preference = 'system';
  try {
    preference = parse(window.localStorage.getItem(key));
  } catch {
    /* Session-only mode. */
  }
  /** @returns {'light' | 'dark'} */
  const resolve = () =>
    preference === 'system' ? (media?.matches ? 'dark' : 'light') : preference;
  /** @type {import('./types').ThemeSnapshot} */
  let snapshot = { preference, resolved: resolve(), persisted: true };
  /** @type {Set<() => void>} */
  const listeners = new Set();
  function apply() {
    const root = document.documentElement;
    root.dataset.theme = snapshot.resolved;
    root.style.colorScheme = snapshot.resolved;
    // Also covers the time before the application stylesheet arrives.
    const background = snapshot.resolved === 'dark' ? '#10151d' : '#f7f8fa';
    root.style.backgroundColor = background;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
  }
  /** @param {boolean} [persisted] */
  function publish(persisted = snapshot.persisted) {
    const resolved = resolve();
    if (
      snapshot.preference === preference &&
      snapshot.resolved === resolved &&
      snapshot.persisted === persisted
    )
      return;
    snapshot = { preference, resolved, persisted };
    apply();
    listeners.forEach((listener) => listener());
  }
  window.__cheapaiTheme = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setPreference(value) {
      preference = value;
      let persisted = true;
      try {
        window.localStorage.setItem(key, preference);
      } catch {
        persisted = false;
      }
      publish(persisted);
    },
  };
  media?.addEventListener('change', () => {
    if (preference === 'system') publish();
  });
  window.addEventListener('storage', (event) => {
    try {
      if (event.storageArea !== window.localStorage) return;
    } catch {
      return;
    }
    if (event.key !== key && event.key !== null) return;
    preference = parse(event.key === null ? null : event.newValue);
    publish(true);
  });
  apply();
  document.addEventListener('DOMContentLoaded', apply, { once: true });
})();
