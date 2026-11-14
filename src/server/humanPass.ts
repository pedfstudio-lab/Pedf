/**
 * Cloudflare Turnstile ("are you a person?") in front of the Sarvam route.
 *
 * The first time someone uses Ask, voice or Translate in a visit, the page runs Turnstile and
 * sends its one-time token to /api/pass. If Cloudflare confirms it, the visitor gets a pass: a
 * signed, 30-minute, security-only cookie (HttpOnly, so page scripts can't read it) sent only to
 * /api/sarvam/*. Requests without a valid pass never reach Sarvam, so a script that fakes the
 * Origin header still can't spend the owner's credits.
 *
 * The pass holds no personal data: an expiry time, a random number and a signature.
 */
export const PASS_COOKIE = 'hp_pass';
export const PASS_SECONDS = 30 * 60;
export const PASS_COOKIE_PATH = '/api/sarvam';
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;

const encoder = new TextEncoder();

function base64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** The signing key comes from the Turnstile secret, so there is no extra secret to manage. */
function signingKey(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(`highpal-pass:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createPass(secret: string, nowMs = Date.now()): Promise<string> {
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(12)).buffer);
  const body = `v1.${Math.floor(nowMs / 1000) + PASS_SECONDS}.${nonce}`;
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(body));
  return `${body}.${base64Url(signature)}`;
}

export async function verifyPass(pass: string | undefined, secret: string, nowMs = Date.now()): Promise<boolean> {
  if (!pass || !secret) return false;
  const parts = pass.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  const expires = Number(parts[1]);
  if (!Number.isInteger(expires) || expires * 1000 <= nowMs || expires * 1000 > nowMs + (PASS_SECONDS + 60) * 1000) return false;
  const signature = fromBase64Url(parts[3]!);
  if (!signature) return false;
  return crypto.subtle.verify('HMAC', await signingKey(secret), signature, encoder.encode(parts.slice(0, 3).join('.')));
}

export function readCookie(headers: Headers, name: string): string | undefined {
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}

export function hasValidPass(request: Request, secret: string): Promise<boolean> {
  return verifyPass(readCookie(request.headers, PASS_COOKIE), secret);
}

/** What the page receives when it must run the human check first. */
export function passRequired(): Response {
  return Response.json({ error: { message: 'Please confirm you are a person first.', code: 'pass_required' } }, { status: 401 });
}

export interface TurnstileResult { readonly success: boolean; readonly hostname?: string }

/** Ask Cloudflare whether a Turnstile token is genuine (each token works once, for 5 minutes). */
export async function verifyTurnstileToken(token: string, secret: string, ip?: string): Promise<TurnstileResult> {
  const form = new URLSearchParams({ secret, response: token });
  if (ip && ip !== 'unknown') form.set('remoteip', ip);
  const response = await fetch(SITEVERIFY_URL, { method: 'POST', body: form });
  if (!response.ok) return { success: false };
  const result = await response.json() as { success?: unknown; hostname?: unknown };
  return { success: result.success === true, ...(typeof result.hostname === 'string' ? { hostname: result.hostname } : {}) };
}

export interface PassRequestOptions {
  readonly secret: string;
  readonly allowedOrigins?: readonly string[];
  /** Pages Turnstile may run on (from APP_ORIGINS); skipped for Cloudflare's local test keys. */
  readonly allowedHostnames?: readonly string[];
  readonly rateLimit?: (ip: string) => Promise<boolean>;
  readonly clientIp: (headers: Headers) => string;
  readonly verifyToken?: (token: string, secret: string, ip: string) => Promise<TurnstileResult>;
  /** False only for the local dev server on plain http://. */
  readonly secureCookie?: boolean;
  readonly now?: () => number;
}

const refused = (status: number, code: string) => Response.json({ error: { message: 'Could not confirm you are a person.', code } }, { status });

/** POST /api/pass {token}: swap a Turnstile token for a 30-minute pass cookie. */
export async function handlePassRequest(request: Request, options: PassRequestOptions): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const origin = request.headers.get('origin');
  if (options.allowedOrigins?.length && (!origin || !options.allowedOrigins.includes(origin))) return new Response('Forbidden', { status: 403 });
  // Not switched on yet (no TURNSTILE_SECRET_KEY): nothing to check, the Sarvam route stays open.
  if (!options.secret) return Response.json({ ok: true, enforced: false, expiresIn: PASS_SECONDS });
  const ip = options.clientIp(request.headers);
  if (options.rateLimit && !await options.rateLimit(ip)) return new Response('Too many requests', { status: 429 });

  let token: unknown;
  try {
    token = (await request.json() as { token?: unknown }).token;
  } catch {
    return refused(400, 'bad_request');
  }
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return refused(400, 'bad_request');

  const result = await (options.verifyToken ?? verifyTurnstileToken)(token, options.secret, ip);
  if (!result.success) return refused(403, 'verification_failed');
  if (options.allowedHostnames?.length && result.hostname && !options.allowedHostnames.includes(result.hostname)) {
    return refused(403, 'wrong_site');
  }

  const pass = await createPass(options.secret, options.now?.());
  const cookie = [`${PASS_COOKIE}=${pass}`, `Path=${PASS_COOKIE_PATH}`, `Max-Age=${PASS_SECONDS}`, 'HttpOnly', 'SameSite=Strict',
    ...(options.secureCookie === false ? [] : ['Secure'])].join('; ');
  return Response.json({ ok: true, enforced: true, expiresIn: PASS_SECONDS }, { headers: { 'set-cookie': cookie } });
}

/** Hostnames from the allowed origins, e.g. "highpal.ai" from "https://highpal.ai". */
export function hostnamesOf(origins: readonly string[] | undefined): string[] | undefined {
  const names = origins?.flatMap((origin) => { try { return [new URL(origin).hostname]; } catch { return []; } });
  return names?.length ? names : undefined;
}
