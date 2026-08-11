import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadPreferredLanguage,
  persistPreferredLanguage,
  resolveDefaultLanguage,
  SUPPORTED_LANGUAGES,
} from './prefsStore';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('preferred-language persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves exact and base browser-language matches with a supported fallback', () => {
    expect(resolveDefaultLanguage(['hi-IN'])).toBe('hi-IN');
    expect(resolveDefaultLanguage(['ta-LK'])).toBe('ta-IN');
    expect(resolveDefaultLanguage(['fr-FR'])).toBe('en-IN');
    expect(SUPPORTED_LANGUAGES.some(({ code }) => code === resolveDefaultLanguage([]))).toBe(true);
  });

  it('persists a preference and restores it on a fresh load', () => {
    const localStorage = memoryStorage();
    vi.stubGlobal('window', { localStorage });
    vi.stubGlobal('navigator', { language: 'en-IN', languages: ['en-IN'] });

    persistPreferredLanguage('ta-IN');

    expect(localStorage.getItem('desipdf.prefs')).toBe('{"preferredLanguage":"ta-IN"}');
    expect(loadPreferredLanguage()).toBe('ta-IN');
  });

  it('uses a supported browser default for missing or invalid storage', () => {
    const localStorage = memoryStorage();
    localStorage.setItem('desipdf.prefs', '{not-json');
    vi.stubGlobal('window', { localStorage });
    vi.stubGlobal('navigator', { language: 'hi-IN', languages: ['hi-IN'] });

    expect(loadPreferredLanguage()).toBe('hi-IN');
  });

  it('returns a supported default without a browser window', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('navigator', undefined);
    expect(loadPreferredLanguage()).toBe('en-IN');
  });
});
