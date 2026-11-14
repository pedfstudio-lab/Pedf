/** HighPal's public Turnstile site key (made for highpal.ai and www.highpal.ai). Public by design. */
export const HIGHPAL_TURNSTILE_SITE_KEY = '0x4AAAAAAGAwaK-1YDGjmFPR';

/**
 * Cloudflare's official test keys, for the local dev server (the real key only works on
 * highpal.ai). Try each case with ?turnstile=pass | interactive | fail in the address bar.
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
export const TEST_SITE_KEYS = {
  pass: '1x00000000000000000000BB',        // always passes, invisible
  interactive: '3x00000000000000000000FF', // always shows the tick-box
  fail: '2x00000000000000000000AB',        // always fails, like a bot
} as const;
export type TestMode = keyof typeof TEST_SITE_KEYS;

const TEST_MODE_KEY = 'highpal.turnstileTestMode';

function testMode(): TestMode {
  try {
    const requested = new URLSearchParams(window.location.search).get('turnstile');
    if (requested && requested in TEST_SITE_KEYS) sessionStorage.setItem(TEST_MODE_KEY, requested);
    const saved = sessionStorage.getItem(TEST_MODE_KEY);
    return saved && saved in TEST_SITE_KEYS ? saved as TestMode : 'pass';
  } catch {
    return 'pass';
  }
}

export function turnstileSiteKey(): string {
  return import.meta.env.DEV ? TEST_SITE_KEYS[testMode()] : HIGHPAL_TURNSTILE_SITE_KEY;
}
