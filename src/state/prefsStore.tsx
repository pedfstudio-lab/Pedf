/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

const PREFS_STORAGE = 'desipdf.prefs';

export const SUPPORTED_LANGUAGES = [
  { code: 'en-IN', label: 'English', name: 'English' },
  { code: 'hi-IN', label: 'हिन्दी', name: 'Hindi' },
  { code: 'ta-IN', label: 'தமிழ்', name: 'Tamil' },
  { code: 'bn-IN', label: 'বাংলা', name: 'Bengali' },
  { code: 'te-IN', label: 'తెలుగు', name: 'Telugu' },
  { code: 'mr-IN', label: 'मराठी', name: 'Marathi' },
  { code: 'gu-IN', label: 'ગુજરાતી', name: 'Gujarati' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ', name: 'Kannada' },
  { code: 'ml-IN', label: 'മലയാളം', name: 'Malayalam' },
  { code: 'pa-IN', label: 'ਪੰਜਾਬੀ', name: 'Punjabi' },
] as const;

export type SupportedLanguageCode = typeof SUPPORTED_LANGUAGES[number]['code'];

interface StoredPreferences {
  readonly preferredLanguage: SupportedLanguageCode;
}

interface PrefsStoreValue {
  readonly preferredLanguage: SupportedLanguageCode;
  setPreferredLanguage(language: SupportedLanguageCode): void;
}

const PrefsStoreContext = createContext<PrefsStoreValue | null>(null);

function browserStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function isSupportedLanguage(value: unknown): value is SupportedLanguageCode {
  return typeof value === 'string' && SUPPORTED_LANGUAGES.some(({ code }) => code === value);
}

export function resolveDefaultLanguage(
  requested: readonly string[] = typeof navigator === 'undefined'
    ? []
    : navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language],
): SupportedLanguageCode {
  for (const language of requested) {
    const exact = SUPPORTED_LANGUAGES.find(
      ({ code }) => code.toLowerCase() === language.toLowerCase(),
    );
    if (exact) return exact.code;
    const base = language.split('-')[0]?.toLowerCase();
    const matchingBase = SUPPORTED_LANGUAGES.find(
      ({ code }) => code.split('-')[0]?.toLowerCase() === base,
    );
    if (matchingBase) return matchingBase.code;
  }
  return 'en-IN';
}

export function loadPreferredLanguage(): SupportedLanguageCode {
  try {
    const stored = browserStorage()?.getItem(PREFS_STORAGE);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<StoredPreferences>;
      if (isSupportedLanguage(parsed.preferredLanguage)) return parsed.preferredLanguage;
    }
  } catch {
    // Ignore invalid or unavailable storage and use a supported browser default.
  }
  return resolveDefaultLanguage();
}

export function persistPreferredLanguage(language: SupportedLanguageCode): void {
  try {
    browserStorage()?.setItem(PREFS_STORAGE, JSON.stringify({ preferredLanguage: language }));
  } catch {
    // The in-memory preference still works when persistence is unavailable.
  }
}

export function PrefsStoreProvider({ children }: { readonly children: ReactNode }) {
  const [preferredLanguage, setLanguage] = useState(loadPreferredLanguage);
  const setPreferredLanguage = useCallback((language: SupportedLanguageCode) => {
    persistPreferredLanguage(language);
    setLanguage(language);
  }, []);
  const value = useMemo(
    () => ({ preferredLanguage, setPreferredLanguage }),
    [preferredLanguage, setPreferredLanguage],
  );

  return (
    <PrefsStoreContext.Provider value={value}>
      {children}
    </PrefsStoreContext.Provider>
  );
}

export function usePrefs(): PrefsStoreValue {
  const store = useContext(PrefsStoreContext);
  if (!store) throw new Error('usePrefs must be used inside PrefsStoreProvider');
  return store;
}
