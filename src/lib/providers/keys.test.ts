import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerConfig } from './config';
import { clearSarvamKey, getSarvamKey, setSarvamKey } from './keys';

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

describe('Sarvam key storage', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: memoryStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips and clears the namespaced browser key', () => {
    expect(getSarvamKey()).toBe('');
    setSarvamKey('sarvam-test-key');
    expect(getSarvamKey()).toBe('sarvam-test-key');
    expect(window.localStorage.getItem('desipdf.sarvamKey')).toBe('sarvam-test-key');
    clearSarvamKey();
    expect(getSarvamKey()).toBe('');
  });

  it('never hands a key to the browser: every Sarvam request goes through the site route', () => {
    expect(providerConfig.mode).toBe('proxy');
    expect(providerConfig.sarvamBaseUrl).toBe('/api/sarvam');
    setSarvamKey('stale-key-from-an-old-version');
    expect(providerConfig.getSarvamKey()).toBe('');
  });

  it('returns an empty key and tolerates writes without a browser window', () => {
    vi.stubGlobal('window', undefined);
    expect(getSarvamKey()).toBe('');
    expect(() => setSarvamKey('ignored')).not.toThrow();
    expect(() => clearSarvamKey()).not.toThrow();
  });
});
