export type ThemePreference = 'system' | 'light' | 'dark';
export interface ThemeSnapshot {
  preference: ThemePreference;
  resolved: 'light' | 'dark';
  persisted: boolean;
}
export interface ThemeStore {
  getSnapshot(): ThemeSnapshot;
  subscribe(listener: () => void): () => void;
  setPreference(preference: ThemePreference): void;
}
declare global {
  interface Window {
    __cheapaiTheme?: ThemeStore;
  }
}
