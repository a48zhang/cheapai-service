import { useId, useSyncExternalStore } from 'react';
import type { ThemePreference } from './types';
import './bootstrap.js';
import './picker.css';
export type { ThemePreference, ThemeSnapshot } from './types';

// bootstrap.js runs before this module and owns the page's single theme store.
export const themeStore = window.__cheapaiTheme!;

const labels = { system: '跟随系统', light: '浅色', dark: '深色' } as const;

/** Native select provides keyboard, screen-reader and OS menu support on both clients. */
export function ThemePicker({ compact = true }: { compact?: boolean }) {
  const { preference, persisted } = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getSnapshot,
  );
  const errorId = useId();
  return (
    <span className="appearance-control">
      <span
        className={`appearance-picker${compact ? ' appearance-picker--compact' : ''}`}
        title={`外观：${labels[preference]}`}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {preference === 'dark' ? (
            <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />
          ) : preference === 'light' ? (
            <>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
            </>
          ) : (
            <>
              <rect x="3" y="4" width="18" height="13" rx="2" />
              <path d="M8 21h8m-4-4v4" />
            </>
          )}
        </svg>
        <select
          aria-label="外观"
          aria-describedby={persisted ? undefined : errorId}
          value={preference}
          onChange={(event) =>
            themeStore.setPreference(event.currentTarget.value as ThemePreference)
          }
        >
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </span>
      {!persisted && (
        <span id={errorId} role="status" className="appearance-save-error">
          外观已切换，暂时无法保存
        </span>
      )}
    </span>
  );
}
