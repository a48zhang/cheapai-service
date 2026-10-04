export const PREFERENCES_VERSION = 1 as const;

const STORAGE_KEY = 'cheapai.desktop.preferences';

export interface DesktopPreferences {
  readonly version: typeof PREFERENCES_VERSION;
  readonly defaultModelId: string | null;
  readonly defaultDirectory: string | null;
}

export type DesktopPreferenceValues = Omit<DesktopPreferences, 'version'>;
export type DesktopPreferencePatch = Partial<DesktopPreferenceValues>;

export const DEFAULT_PREFERENCES: DesktopPreferences = {
  version: PREFERENCES_VERSION,
  defaultModelId: null,
  defaultDirectory: null,
};

/** Read non-sensitive settings from this stable account's local preference space. */
export function readPreferences(userId: string | null = null): DesktopPreferences {
  const storage = localStorageOrNull();
  if (storage === null) return { ...DEFAULT_PREFERENCES };

  try {
    const raw = storage.getItem(storageKey(userId));
    if (raw === null) return { ...DEFAULT_PREFERENCES };
    return parsePreferences(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Persist a partial setting update under the stable account ID, never a login credential. */
export function savePreferences(userId: string | null, patch: DesktopPreferencePatch): DesktopPreferences {
  const current = readPreferences(userId);
  const next: DesktopPreferences = {
    version: PREFERENCES_VERSION,
    defaultModelId: patch.defaultModelId === undefined
      ? current.defaultModelId
      : normalizeText(patch.defaultModelId),
    defaultDirectory: patch.defaultDirectory === undefined
      ? current.defaultDirectory
      : normalizeText(patch.defaultDirectory),
  };
  const storage = localStorageOrNull();
  if (storage === null) throw new Error('Local preference storage is unavailable.');
  storage.setItem(storageKey(userId), JSON.stringify(next));
  return next;
}

function storageKey(userId: string | null): string {
  if (userId === null || userId.trim() === '') return STORAGE_KEY;
  return `${STORAGE_KEY}:user:${encodeURIComponent(userId)}`;
}

function parsePreferences(value: unknown): DesktopPreferences {
  if (!isRecord(value) || value.version !== PREFERENCES_VERSION) {
    return { ...DEFAULT_PREFERENCES };
  }

  return {
    version: PREFERENCES_VERSION,
    defaultModelId: parseText(value.defaultModelId),
    defaultDirectory: parseText(value.defaultDirectory),
  };
}

function parseText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function normalizeText(value: string | null): string | null {
  return value === null ? null : parseText(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function localStorageOrNull(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
