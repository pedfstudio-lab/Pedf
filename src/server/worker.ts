import { handlePassRequest, hasValidPass, hostnamesOf, passRequired } from './humanPass';
import { clientIp, handleSarvamProxy } from './sarvamProxy';
import { handleSarvamSocket, type RelaySocket } from './sarvamSocket';

/** Cloudflare's built-in rate limiter (the SARVAM_LIMITER binding in wrangler.jsonc). */
interface RateLimiter {
  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

export interface WorkerEnvironment {
  /** The website files (dist/), served as they are. */
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  /** The owner's Sarvam key: an encrypted Cloudflare secret, never in code or the browser. */
  readonly SARVAM_API_KEY?: string;
  /** Comma-separated sites allowed to use the Sarvam route, e.g. the live address. */
  readonly APP_ORIGINS?: string;
  readonly SARVAM_LIMITER?: RateLimiter;
  /** Cloudflare Turnstile secret (encrypted). Once set, Sarvam requests need a human-check pass. */
  readonly TURNSTILE_SECRET_KEY?: string;
}

export function allowedOrigins(value?: string): string[] | undefined {
  const origins = value?.split(',').map((origin) => origin.trim()).filter(Boolean);
  return origins && origins.length > 0 ? origins : undefined;
}

/** Cloudflare's WebSocket pieces, which the browser and Node typings don't know about. */
type CloudflareSocket = RelaySocket & { accept(): void };
const cloudflare = globalThis as unknown as { WebSocketPair?: new () => { 0: CloudflareSocket; 1: CloudflareSocket } };

/** Sarvam's side of a live connection, opened with the key in a header (never in the URL). */
async function connectSarvam(url: string, apiKey: string): Promise<RelaySocket | undefined> {
  const response = await fetch(url, { headers: { Upgrade: 'websocket', 'api-subscription-key': apiKey } });
  const socket = (response as Response & { webSocket?: CloudflareSocket | null }).webSocket;
  if (!socket) return undefined;
  socket.accept();
  return socket;
}

function acceptBrowserSocket(): { client: unknown; server: RelaySocket } {
  if (!cloudflare.WebSocketPair) throw new Error('WebSocketPair is only available on Cloudflare.');
  const pair = new cloudflare.WebSocketPair();
  pair[1].accept();
  return { client: pair[0], server: pair[1] };
}

/**
 * Only /api/* runs code (wrangler.jsonc runs this Worker first for /api/* only). /api/sarvam/*:
 * Ask, voice and Translate reach Sarvam here, with the owner's key added on Cloudflare's side;
 * Conversation and spoken answers use live connections (WebSockets) on the same route.
 * /api/pass: the Turnstile human check that the Sarvam route requires (humanPass.ts).
 * Every other request is a plain website file.
 */
export default {
  async fetch(request: Request, env: WorkerEnvironment): Promise<Response> {
    const { pathname } = new URL(request.url);
    const limiter = env.SARVAM_LIMITER;
    const rateLimit = limiter ? { rateLimit: async (ip: string) => (await limiter.limit({ key: ip })).success } : {};
    const origins = allowedOrigins(env.APP_ORIGINS);
    const turnstileSecret = env.TURNSTILE_SECRET_KEY?.trim() ?? '';
    if (pathname === '/api/pass') {
      return handlePassRequest(request, {
        secret: turnstileSecret,
        allowedOrigins: origins,
        allowedHostnames: hostnamesOf(origins),
        clientIp,
        ...rateLimit,
      });
    }
    if (pathname.startsWith('/api/sarvam/')) {
      // Switched on by the TURNSTILE_SECRET_KEY secret, so a missing key can't lock everyone out.
      if (turnstileSecret && !await hasValidPass(request, turnstileSecret)) return passRequired();
      const shared = {
        apiKey: env.SARVAM_API_KEY ?? '',
        allowedOrigins: origins,
        ...rateLimit,
      };
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        return handleSarvamSocket(request, {
          ...shared,
          connectUpstream: connectSarvam,
          accept: acceptBrowserSocket,
          respond: (client) => new Response(null, { status: 101, webSocket: client } as ResponseInit),
        });
      }
      return handleSarvamProxy(request, shared);
    }
    if (pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
