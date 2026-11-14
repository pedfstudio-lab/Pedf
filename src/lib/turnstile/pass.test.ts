// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnstileApi } from './pass';
import { TEST_SITE_KEYS } from './siteKey';

type Options = Parameters<TurnstileApi['render']>[1];

let rendered: Options[];
let fakeTurnstile: TurnstileApi & { render: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
let fetchMock: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

/** A fresh copy of the module each time, so a pass from one test doesn't carry into the next. */
async function load() {
  vi.resetModules();
  return import('./pass');
}

const lastOptions = () => rendered.at(-1)!;
/** The widget appears a moment after the check starts (once the Turnstile script is ready). */
async function widget(count = 1): Promise<Options> {
  await vi.waitFor(() => expect(rendered.length).toBeGreaterThanOrEqual(count));
  return lastOptions();
}
const overlay = () => document.querySelector<HTMLElement>('[data-human-check]');

beforeEach(() => {
  rendered = [];
  fakeTurnstile = {
    render: vi.fn((_container: HTMLElement, options: Options) => { rendered.push(options); return `widget-${rendered.length}`; }),
    remove: vi.fn(),
  };
  window.turnstile = fakeTurnstile;
  fetchMock = vi.fn(async () => Response.json({ ok: true, enforced: true, expiresIn: 1800 }));
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete window.turnstile;
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('the human check before Ask, voice and Translate', () => {
  it('passes invisibly, swaps the token for a pass, and then stops checking for a while', async () => {
    const { ensurePass } = await load();
    const checking = ensurePass();
    const options = await widget();
    expect(options.sitekey).toBe(TEST_SITE_KEYS.pass); // Cloudflare's test key on the dev server
    expect(options.appearance).toBe('interaction-only');
    expect(overlay()?.style.display).toBe('none');
    options.callback('one-time-token');
    await checking;
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/pass');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'one-time-token' });
    expect(fakeTurnstile.remove).toHaveBeenCalledWith('widget-1');
    expect(overlay()).toBeNull();

    await ensurePass();
    expect(fakeTurnstile.render).toHaveBeenCalledOnce();
  });

  it('shows the "Quick check" card only while Cloudflare wants a tick', async () => {
    const { ensurePass } = await load();
    const checking = ensurePass();
    const options = await widget();
    options['before-interactive-callback']();
    expect(overlay()?.style.display).toBe('flex');
    expect(overlay()?.textContent).toContain('Quick check');
    options['after-interactive-callback']();
    expect(overlay()?.style.display).toBe('none');
    options.callback('ticked-token');
    await checking;
  });

  it('runs one check even when Ask and voice ask at the same moment', async () => {
    const { ensurePass } = await load();
    const first = ensurePass();
    const second = ensurePass();
    (await widget()).callback('token');
    await Promise.all([first, second]);
    expect(fakeTurnstile.render).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fails with a plain message when Cloudflare or the server says no', async () => {
    const { ensurePass, HUMAN_CHECK_FAILED } = await load();
    const blocked = ensurePass();
    expect((await widget())['error-callback']()).toBe(true);
    await expect(blocked).rejects.toMatchObject({ name: 'HumanCheckError', message: HUMAN_CHECK_FAILED });
    expect(overlay()).toBeNull();

    fetchMock.mockResolvedValueOnce(new Response('no', { status: 403 }));
    const refused = ensurePass();
    (await widget(2)).callback('token');
    await expect(refused).rejects.toMatchObject({ name: 'HumanCheckError' });
  });

  it('checks again after the server reports the pass expired', async () => {
    const { ensurePass, resetPass } = await load();
    const first = ensurePass();
    (await widget()).callback('token-1');
    await first;
    resetPass();
    const again = ensurePass();
    (await widget(2)).callback('token-2');
    await again;
    expect(fakeTurnstile.render).toHaveBeenCalledTimes(2);
  });

  it('loads Cloudflare\'s Turnstile script only when an AI feature is first used', async () => {
    delete window.turnstile;
    const { ensurePass } = await load();
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
    const checking = ensurePass();
    const script = document.querySelector<HTMLScriptElement>('script[src*="challenges.cloudflare.com"]');
    expect(script?.src).toBe('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    window.turnstile = fakeTurnstile;
    script!.dispatchEvent(new Event('load'));
    (await widget()).callback('token');
    await checking;
  });

  it('uses the tick-box and bot test keys when asked to on the dev server', async () => {
    window.history.replaceState({}, '', '/app?turnstile=interactive');
    const { ensurePass } = await load();
    const checking = ensurePass();
    const options = await widget();
    expect(options.sitekey).toBe(TEST_SITE_KEYS.interactive);
    options.callback('token');
    await checking;
    window.history.replaceState({}, '', '/app');
  });
});
