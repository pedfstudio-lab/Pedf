import { turnstileSiteKey } from './siteKey';

/**
 * The human check in front of Ask, voice, Conversation and Translate (see src/server/humanPass.ts).
 * Turnstile loads only when one of those is first used, runs invisibly for most people, and shows
 * a tick-box overlay only when Cloudflare asks for one. Its one-time token is swapped at /api/pass
 * for a 30-minute, security-only pass cookie that page scripts can't read.
 */
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const REFRESH_MARGIN_MS = 2 * 60_000;
const CHECK_TIMEOUT_MS = 90_000;

export const HUMAN_CHECK_FAILED = "We couldn't confirm you're a person, so Ask, voice and Translate are paused. Check your connection and try again.";

export class HumanCheckError extends Error {
  constructor(message = HUMAN_CHECK_FAILED) {
    super(message);
    this.name = 'HumanCheckError';
  }
}

interface TurnstileOptions {
  sitekey: string;
  appearance: 'interaction-only';
  action: string;
  callback: (token: string) => void;
  'error-callback': () => boolean;
  'expired-callback': () => void;
  'timeout-callback': () => void;
  'before-interactive-callback': () => void;
  'after-interactive-callback': () => void;
}
export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileOptions): string | undefined;
  remove(widgetId: string): void;
}
declare global {
  interface Window { turnstile?: TurnstileApi }
}

let validUntil = 0;
let pending: Promise<void> | null = null;
let scriptLoading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptLoading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new HumanCheckError());
    script.onerror = () => { script.remove(); reject(new HumanCheckError()); };
    document.head.append(script);
  }).catch((error: unknown) => {
    scriptLoading = null;
    throw error;
  });
  return scriptLoading;
}

/** A small card in the middle of the screen, shown only while Cloudflare wants a tick. */
function createOverlay() {
  const root = document.createElement('div');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'human-check-title');
  root.dataset.humanCheck = 'true';
  root.style.cssText = 'position:fixed;inset:0;z-index:2000;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(10,16,12,.45)';
  const card = document.createElement('div');
  card.style.cssText = 'max-width:380px;width:100%;border-radius:14px;background:#fff;padding:22px;box-shadow:0 20px 50px rgba(0,0,0,.25);font-family:inherit;color:#1f3a2e';
  const title = document.createElement('h2');
  title.id = 'human-check-title';
  title.textContent = 'Quick check';
  title.style.cssText = 'margin:0 0 6px;font-size:18px;font-weight:700';
  const text = document.createElement('p');
  text.textContent = "Please confirm you're a person to use Ask, voice and Translate. It keeps HighPal's AI free from misuse.";
  text.style.cssText = 'margin:0 0 14px;font-size:14px;line-height:1.5;color:#4a5d52';
  const slot = document.createElement('div');
  card.append(title, text, slot);
  root.append(card);
  return { root, slot, show: () => { root.style.display = 'flex'; }, hide: () => { root.style.display = 'none'; } };
}

function getToken(api: TurnstileApi): Promise<string> {
  return new Promise((resolve, reject) => {
    const overlay = createOverlay();
    document.body.append(overlay.root);
    let widgetId: string | undefined;
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (widgetId) { try { api.remove(widgetId); } catch { /* Already gone. */ } }
      overlay.root.remove();
      outcome();
    };
    const fail = () => finish(() => reject(new HumanCheckError()));
    const timer = setTimeout(fail, CHECK_TIMEOUT_MS);
    try {
      widgetId = api.render(overlay.slot, {
        sitekey: turnstileSiteKey(),
        appearance: 'interaction-only',
        action: 'ai-features',
        callback: (token) => finish(() => resolve(token)),
        'error-callback': () => { fail(); return true; },
        'expired-callback': fail,
        'timeout-callback': fail,
        'before-interactive-callback': overlay.show,
        'after-interactive-callback': overlay.hide,
      }) ?? undefined;
    } catch {
      fail();
    }
  });
}

async function exchange(token: string): Promise<number> {
  const response = await fetch('/api/pass', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new HumanCheckError();
  const result = await response.json() as { expiresIn?: unknown };
  return typeof result.expiresIn === 'number' && result.expiresIn > 0 ? result.expiresIn : 30 * 60;
}

/** Makes sure this browser holds a current pass before an AI request; checks at most once at a time. */
export function ensurePass(): Promise<void> {
  if (Date.now() < validUntil - REFRESH_MARGIN_MS) return Promise.resolve();
  pending ??= (async () => {
    try {
      const token = await getToken(await loadTurnstile());
      const seconds = await exchange(token);
      validUntil = Date.now() + seconds * 1000;
    } catch (error) {
      throw error instanceof HumanCheckError ? error : new HumanCheckError();
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** The server said the pass is missing or expired: check again next time. */
export function resetPass(): void {
  validUntil = 0;
}
