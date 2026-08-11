const SARVAM_KEY_STORAGE = 'desipdf.sarvamKey';

function browserStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function getSarvamKey(): string {
  try {
    return browserStorage()?.getItem(SARVAM_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setSarvamKey(key: string): void {
  try {
    browserStorage()?.setItem(SARVAM_KEY_STORAGE, key);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export function clearSarvamKey(): void {
  try {
    browserStorage()?.removeItem(SARVAM_KEY_STORAGE);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}
