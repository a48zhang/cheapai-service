import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { themeStore } from '@cheapai/theme';

/** Native chrome follows the same preference as the webview, including system mode. */
export function syncNativeTheme(): () => void {
  if (!isTauri()) return () => undefined;
  const nativeWindow = getCurrentWindow();
  let pending = Promise.resolve();
  let disposed = false;
  const update = () => {
    const { preference } = themeStore.getSnapshot();
    pending = pending
      .then(async () => {
        if (!disposed) await nativeWindow.setTheme(preference === 'system' ? null : preference);
      })
      .catch(() => {
        // Webview appearance remains usable if native chrome cannot be changed.
      });
  };
  update();
  const unsubscribe = themeStore.subscribe(update);
  return () => {
    disposed = true;
    unsubscribe();
  };
}
