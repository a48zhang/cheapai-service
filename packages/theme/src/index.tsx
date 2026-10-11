import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent } from 'react';
import type { ThemePreference } from './types';
import './bootstrap.js';
import './picker.css';
export type { ThemePreference, ThemeSnapshot } from './types';

// bootstrap.js runs before this module and owns the page's single theme store.
export const themeStore = window.__cheapaiTheme!;

const labels = { system: '跟随系统', light: '浅色', dark: '深色' } as const;
const choices: ThemePreference[] = ['light', 'dark', 'system'];

function ThemeIcon({ theme }: { theme: ThemePreference }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {theme === 'dark' ? (
        <path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z" />
      ) : theme === 'light' ? (
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
  );
}

export function ThemePicker({ compact = true }: { compact?: boolean }) {
  const { preference, resolved, persisted } = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getSnapshot,
  );
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const initialFocus = useRef<number | null>(null);
  const menuId = useId();
  const errorId = useId();

  useEffect(() => {
    if (!open) return;
    optionRefs.current[initialFocus.current ?? choices.indexOf(preference)]?.focus();
    initialFocus.current = null;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, preference]);

  const closeAndFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeAndFocus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const current = optionRefs.current.findIndex((option) => option === document.activeElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? choices.length - 1
            : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      optionRefs.current[next]?.focus();
    }
  };

  return (
    <span
      ref={rootRef}
      className="appearance-control"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`appearance-picker${compact ? ' appearance-picker--compact' : ''}`}
        title={`外观：${labels[preference]}`}
        aria-label="外观"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-describedby={persisted ? undefined : errorId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            initialFocus.current = event.key === 'ArrowDown' ? 0 : choices.length - 1;
            setOpen(true);
          }
        }}
      >
        <ThemeIcon theme={resolved} />
        {!compact && <span>{labels[preference]}</span>}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="外观"
          className="appearance-menu"
          onKeyDown={onMenuKeyDown}
        >
          {choices.map((choice, index) => (
            <button
              key={choice}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={choice === preference}
              tabIndex={choice === preference ? 0 : -1}
              className="appearance-option"
              onClick={() => {
                themeStore.setPreference(choice);
                closeAndFocus();
              }}
            >
              <ThemeIcon theme={choice} />
              <span>{labels[choice]}</span>
              {choice === preference && (
                <svg
                  aria-hidden="true"
                  className="appearance-check"
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m5 12 4 4L19 6" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
      {!persisted && (
        <span id={errorId} role="status" className="appearance-save-error">
          外观已切换，暂时无法保存
        </span>
      )}
    </span>
  );
}
