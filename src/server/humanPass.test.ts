import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPass, handlePassRequest, hostnamesOf, PASS_COOKIE, PASS_SECONDS, readCookie, verifyPass, verifyTurnstileToken,
  type PassRequestOptions,
} from './humanPass';

const SECRET = 'turnstile-test-secret';
const SITE = 'https://highpal.ai';

afterEach(() => vi.unstubAllGlobals());

function passRequest(body: unknown = { token: 'one-time-token' }, origin = SITE): Request {
  return new Request(`${SITE}/api/pass`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, 'cf-connecting-ip': '203.0.113.9' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function options(overrides: Partial<PassRequestOptions> = {}): PassRequestOptions {
  return {
    secret: SECRET,
    allowedOrigins: [SITE, 'https://www.highpal.ai'],
    allowedHostnames: ['highpal.ai', 'www.highpal.ai'],
    clientIp: (headers) => headers.get('cf-connecting-ip') ?? 'unknown',
    verifyToken: async () => ({ success: true, hostname: 'highpal.ai' }),
    ...overrides,
  };
}

describe('the human-check pass', () => {
  it('is accepted for 30 minutes, then refused', async () => {
    const now = Date.UTC(2026, 10, 14, 10, 0, 0);
    const pass = await createPass(SECRET, now);
    expect(await verifyPass(pass, SECRET, now)).toBe(true);
    expect(await verifyPass(pass, SECRET, now + (PASS_SECONDS - 5) * 1000)).toBe(true);
    expect(await verifyPass(pass, SECRET, now + (PASS_SECONDS + 5) * 1000)).toBe(false);
  });

  it('cannot be forged, edited or reused with another secret', async () => {
    const pass = await createPass(SECRET);
    const [version, expires, nonce, signature] = pass.split('.');
    expect(await verifyPass(pass, 'another-secret')).toBe(false);
    // Pushing the expiry later breaks the signature.
    expect(await verifyPass([version, Number(expires) + 600, nonce, signature].join('.'), SECRET)).toBe(false);
    expect(await verifyPass(`${version}.${expires}.${nonce}.${signature!.slice(0, -2)}xx`, SECRET)).toBe(false);
    for (const junk of [undefined, '', 'nonsense', 'v1.1.2', 'v2.1.2.3']) expect(await verifyPass(junk, SECRET)).toBe(false);
    expect(await verifyPass(pass, '')).toBe(false);
  });

  it('holds no personal data: only an expiry, a random number and a signature', async () => {
    const pass = await createPass(SECRET);
    expect(pass).toMatch(/^v1\.\d{10}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(await createPass(SECRET)).not.toBe(pass);
  });

  it('reads the pass from the cookie header', () => {
    expect(readCookie(new Headers({ cookie: `a=1; ${PASS_COOKIE}=v1.2.3.4=; b=2` }), PASS_COOKIE)).toBe('v1.2.3.4=');
    expect(readCookie(new Headers(), PASS_COOKIE)).toBeUndefined();
  });
});

describe('POST /api/pass', () => {
  it('swaps a genuine Turnstile token for a secure, script-proof 30-minute pass cookie', async () => {
    const verifyToken = vi.fn(async () => ({ success: true, hostname: 'highpal.ai' }));
    const response = await handlePassRequest(passRequest(), options({ verifyToken }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, enforced: true, expiresIn: PASS_SECONDS });
    expect(verifyToken).toHaveBeenCalledWith('one-time-token', SECRET, '203.0.113.9');
    const cookie = response.headers.get('set-cookie') ?? '';
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/sarvam', `Max-Age=${PASS_SECONDS}`]) expect(cookie).toContain(part);
    const pass = cookie.match(new RegExp(`${PASS_COOKIE}=([^;]+)`))?.[1];
    expect(await verifyPass(pass, SECRET)).toBe(true);
  });

  it('gives no pass when Cloudflare says no, or the check ran on another website', async () => {
    const refused = await handlePassRequest(passRequest(), options({ verifyToken: async () => ({ success: false }) }));
    expect(refused.status).toBe(403);
    expect(refused.headers.get('set-cookie')).toBeNull();
    const elsewhere = await handlePassRequest(passRequest(), options({ verifyToken: async () => ({ success: true, hostname: 'copycat.example' }) }));
    expect(elsewhere.status).toBe(403);
    expect(elsewhere.headers.get('set-cookie')).toBeNull();
  });

  it('refuses other websites, bad requests, and visitors over the limit', async () => {
    expect((await handlePassRequest(passRequest(undefined, 'https://copycat.example'), options())).status).toBe(403);
    expect((await handlePassRequest(passRequest('not json'), options())).status).toBe(400);
    expect((await handlePassRequest(passRequest({ token: '' }), options())).status).toBe(400);
    expect((await handlePassRequest(passRequest({ token: 'x'.repeat(3000) }), options())).status).toBe(400);
    expect((await handlePassRequest(new Request(`${SITE}/api/pass`), options())).status).toBe(405);
    expect((await handlePassRequest(passRequest(), options({ rateLimit: async () => false }))).status).toBe(429);
  });

  it('stays open, with no cookie, until TURNSTILE_SECRET_KEY is set', async () => {
    const verifyToken = vi.fn();
    const response = await handlePassRequest(passRequest(), options({ secret: '', verifyToken }));
    expect(await response.json()).toEqual({ ok: true, enforced: false, expiresIn: PASS_SECONDS });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('drops Secure only for the local http:// dev server', async () => {
    const response = await handlePassRequest(passRequest(), options({ secureCookie: false }));
    expect(response.headers.get('set-cookie')).not.toContain('Secure');
  });
});

describe('asking Cloudflare about a token', () => {
  it('sends the secret, the token and the visitor address, and reads the answer', async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => Response.json({ success: true, hostname: 'highpal.ai' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await verifyTurnstileToken('tok', SECRET, '203.0.113.9')).toEqual({ success: true, hostname: 'highpal.ai' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ secret: SECRET, response: 'tok', remoteip: '203.0.113.9' });

    fetchMock.mockResolvedValueOnce(new Response('down', { status: 500 }));
    expect(await verifyTurnstileToken('tok', SECRET)).toEqual({ success: false });
  });

  it('lists the hostnames of the allowed sites', () => {
    expect(hostnamesOf(['https://highpal.ai', 'https://www.highpal.ai'])).toEqual(['highpal.ai', 'www.highpal.ai']);
    expect(hostnamesOf(undefined)).toBeUndefined();
  });
});
