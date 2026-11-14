import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPass, PASS_COOKIE } from './humanPass';
import worker, { allowedOrigins, type WorkerEnvironment } from './worker';

const LIVE = 'https://highpal.ai';

function environment(overrides: Partial<WorkerEnvironment> = {}): WorkerEnvironment & { assets: ReturnType<typeof vi.fn> } {
  const assets = vi.fn(async () => new Response('<!doctype html>website', { status: 200 }));
  return { ASSETS: { fetch: assets }, SARVAM_API_KEY: 'server-secret', APP_ORIGINS: LIVE, assets, ...overrides };
}

const ask = (origin = LIVE, path = 'v1/chat/completions') => new Request(`${LIVE}/api/sarvam/${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin, 'cf-connecting-ip': '203.0.113.7' },
  body: '{"messages":[]}',
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Sarvam route (Cloudflare Worker)', () => {
  it('adds the server key on the way to Sarvam and never sends it back', async () => {
    const upstream = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response('{"choices":[]}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', upstream);
    const env = environment();

    const response = await worker.fetch(ask(), env);

    expect(response.status).toBe(200);
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe('https://api.sarvam.ai/v1/chat/completions');
    expect(new Headers(init.headers).get('api-subscription-key')).toBe('server-secret');
    expect(response.headers.get('api-subscription-key')).toBeNull();
    expect(await response.text()).not.toContain('server-secret');
    expect(env.assets).not.toHaveBeenCalled();
  });

  it('refuses other websites, so only HighPal can spend the credits', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await worker.fetch(ask('https://someone-else.example'), environment());
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('stops a visitor who goes over the per-minute limit', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const limit = vi.fn(async () => ({ success: false }));
    const response = await worker.fetch(ask(), environment({ SARVAM_LIMITER: { limit } }));
    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.7' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('says "not set up" instead of calling Sarvam when the secret is missing', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await worker.fetch(ask(), environment({ SARVAM_API_KEY: undefined }));
    expect(response.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('serves every other address as a plain website file', async () => {
    const env = environment();
    const response = await worker.fetch(new Request(`${LIVE}/app`), env);
    expect(await response.text()).toContain('website');
    expect(env.assets).toHaveBeenCalledTimes(1);
    expect((await worker.fetch(new Request(`${LIVE}/api/other`), env)).status).toBe(404);
  });

  it('reads the allowed sites from a comma-separated setting', () => {
    expect(allowedOrigins(` ${LIVE}, https://pedfstudio.example `)).toEqual([LIVE, 'https://pedfstudio.example']);
    expect(allowedOrigins('')).toBeUndefined();
  });
});

describe('the human check in front of the Sarvam route (Turnstile)', () => {
  const SECRET = 'turnstile-secret';
  const withPass = async (request: Request) => {
    const headers = new Headers(request.headers);
    headers.set('cookie', `${PASS_COOKIE}=${await createPass(SECRET)}`);
    return new Request(request, { headers });
  };

  it('refuses Sarvam requests without a pass once TURNSTILE_SECRET_KEY is set, even with a faked Origin', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const response = await worker.fetch(ask(), environment({ TURNSTILE_SECRET_KEY: SECRET }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'pass_required' } });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('lets a request with a valid pass through to Sarvam', async () => {
    const upstream = vi.fn(async () => new Response('{"choices":[]}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    const response = await worker.fetch(await withPass(ask()), environment({ TURNSTILE_SECRET_KEY: SECRET }));
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('refuses live voice connections without a pass too', async () => {
    const socket = new Request(`${LIVE}/api/sarvam/text-to-speech/ws?model=bulbul%3Av3&send_completion_event=true`, {
      headers: { upgrade: 'websocket', origin: LIVE },
    });
    expect((await worker.fetch(socket, environment({ TURNSTILE_SECRET_KEY: SECRET }))).status).toBe(401);
  });

  it('keeps working exactly as before until the secret is set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"choices":[]}', { status: 200 })));
    expect((await worker.fetch(ask(), environment())).status).toBe(200);
  });

  it('serves /api/pass: a genuine Turnstile token from highpal.ai gets the pass cookie', async () => {
    const siteverify = vi.fn(async () => Response.json({ success: true, hostname: 'highpal.ai' }));
    vi.stubGlobal('fetch', siteverify);
    const response = await worker.fetch(new Request(`${LIVE}/api/pass`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: LIVE, 'cf-connecting-ip': '203.0.113.7' },
      body: JSON.stringify({ token: 'turnstile-token' }),
    }), environment({ TURNSTILE_SECRET_KEY: SECRET }));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain(`${PASS_COOKIE}=`);
    expect(siteverify).toHaveBeenCalledOnce();
  });
});

describe('Cloudflare setup (wrangler.jsonc)', () => {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, '')) as {
    main: string; assets: { binding: string; run_worker_first: string[] }; vars: { APP_ORIGINS: string } & Record<string, string | undefined>;
    ratelimits: { name: string; simple: { limit: number; period: number } }[];
  };

  it('runs the route only for /api/* and serves everything else as files', () => {
    expect(config.main).toBe('src/server/worker.ts');
    expect(config.assets.binding).toBe('ASSETS');
    expect(config.assets.run_worker_first).toEqual(['/api/*']);
  });

  it('allows only highpal.ai (the old workers.dev address is off) and limits each visitor', () => {
    expect(config.vars.APP_ORIGINS.split(',')).toEqual(['https://highpal.ai', 'https://www.highpal.ai']);
    expect(config.ratelimits).toEqual([expect.objectContaining({ name: 'SARVAM_LIMITER', simple: { limit: 60, period: 60 } })]);
  });

  it('never holds the keys themselves: those are encrypted Cloudflare secrets', () => {
    expect(config.vars).not.toHaveProperty('SARVAM_API_KEY');
    expect(config.vars).not.toHaveProperty('TURNSTILE_SECRET_KEY');
    expect(readFileSync('.gitignore', 'utf8')).toMatch(/^\.dev\.vars$/m);
  });
});
