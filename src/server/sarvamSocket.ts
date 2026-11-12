import {
  SARVAM_STT_STREAM_PATH,
  SARVAM_TTS_STREAM_PATH,
  STT_REALTIME_MODEL,
  STT_REALTIME_SAMPLE_RATE,
  TTS_MODEL,
} from '../lib/providers/sarvamVoice';
import { clientIp } from './sarvamProxy';

/** One conversation's live connection lasts at most 10 minutes; the app opens a new one after. */
export const SOCKET_MAX_MS = 10 * 60_000;
/** Closed when the browser sends nothing for a minute (its keep-alives arrive every few seconds). */
export const SOCKET_IDLE_MS = 60_000;

type Message = string | ArrayBuffer | ArrayBufferView;

/** The part of a WebSocket the relay needs (Cloudflare's and the test fakes both fit). */
export interface RelaySocket {
  send(data: Message): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: { readonly data: Message }) => void): void;
  addEventListener(type: 'close' | 'error', listener: (event: { readonly code?: number; readonly reason?: string }) => void): void;
}

export interface SocketTimers {
  set(callback: () => void, ms: number): unknown;
  clear(id: unknown): void;
}

const exact = (value: string | number) => new RegExp(`^${String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/**
 * Exactly the settings the app's own voice code sends (sarvam.ts), all required, so the owner's
 * key can't be used for other Sarvam models or services.
 */
const SOCKET_RULES: Readonly<Record<string, Readonly<Record<string, RegExp>>>> = {
  [SARVAM_STT_STREAM_PATH]: {
    language_code: /^(?:[a-z]{2}-IN|auto|unknown)$/,
    model: exact(STT_REALTIME_MODEL),
    stream_type: /^fast$/,
    mode: /^transcribe$/,
    endpointing: /^manual$/,
    encoding: /^linear16$/,
    sample_rate: exact(STT_REALTIME_SAMPLE_RATE),
  },
  [SARVAM_TTS_STREAM_PATH]: {
    model: exact(TTS_MODEL),
    send_completion_event: /^true$/,
  },
};

export interface SarvamSocketOptions {
  readonly apiKey: string;
  readonly allowedOrigins?: readonly string[];
  readonly rateLimit?: (ip: string) => Promise<boolean>;
  /** Opens Sarvam's side with the key in a header; undefined when Sarvam refuses. */
  connectUpstream(url: string, apiKey: string): Promise<RelaySocket | undefined>;
  /** A new browser-facing socket pair: `client` goes back in the 101 response. */
  accept(): { readonly client: unknown; readonly server: RelaySocket };
  respond(client: unknown): Response;
  readonly timers?: SocketTimers;
}

const realTimers: SocketTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Browsers and Workers only accept 1000 or 3000–4999 from close(). */
const sendable = (code?: number) => code === 1000 || (code !== undefined && code >= 3000 && code <= 4999) ? code : 1000;

/** Pass every message both ways until either side closes, the time limit, or a quiet minute. */
export function relaySockets(client: RelaySocket, upstream: RelaySocket, timers: SocketTimers = realTimers,
  { maxMs = SOCKET_MAX_MS, idleMs = SOCKET_IDLE_MS } = {}): void {
  const state: { finished: boolean; idleTimer?: unknown; maxTimer?: unknown } = { finished: false };
  const finish = (code?: number, reason = '') => {
    if (state.finished) return;
    state.finished = true;
    timers.clear(state.maxTimer);
    timers.clear(state.idleTimer);
    for (const socket of [client, upstream]) {
      try { socket.close(sendable(code), reason.slice(0, 120)); } catch { /* already closed */ }
    }
  };
  const restartIdle = () => {
    timers.clear(state.idleTimer);
    state.idleTimer = timers.set(() => finish(4008, 'Closed after a quiet minute'), idleMs);
  };
  state.maxTimer = timers.set(() => finish(4000, 'Conversation time limit reached'), maxMs);
  restartIdle();
  client.addEventListener('message', (event) => {
    restartIdle();
    try { upstream.send(event.data); } catch { finish(4011, 'Sarvam connection failed'); }
  });
  upstream.addEventListener('message', (event) => {
    try { client.send(event.data); } catch { finish(1000); }
  });
  client.addEventListener('close', (event) => finish(event.code));
  upstream.addEventListener('close', (event) => finish(event.code, event.reason ?? ''));
  client.addEventListener('error', () => finish(1000));
  upstream.addEventListener('error', () => finish(4011, 'Sarvam connection failed'));
}

/** The live-connection paths (/api/sarvam/text-to-speech/ws and …/speech-to-text-realtime/ws). */
export function isSarvamSocketPath(pathname: string): boolean {
  return socketRules(pathname) !== undefined;
}

function socketRules(pathname: string): Readonly<Record<string, RegExp>> | undefined {
  const path = pathname.replace(/^\/api\/sarvam\//, '');
  return Object.hasOwn(SOCKET_RULES, path) ? SOCKET_RULES[path] : undefined;
}

/**
 * The live-connection half of the Sarvam route: same website check, key and per-visitor limit
 * as the one-off requests, plus the 10-minute and quiet-minute limits. The key is added on the
 * server, in a header, and never goes back to the browser.
 */
export async function handleSarvamSocket(request: Request, options: SarvamSocketOptions): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected a WebSocket', { status: 426 });
  }
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/sarvam\//, '');
  const rules = socketRules(url.pathname);
  if (!rules) return new Response('Not found', { status: 404 });

  const origin = request.headers.get('origin');
  if (options.allowedOrigins?.length && (!origin || !options.allowedOrigins.includes(origin))) {
    return new Response('Forbidden', { status: 403 });
  }
  const apiKey = options.apiKey.trim();
  if (!apiKey) return new Response('Proxy not configured', { status: 503 });

  const settings = [...url.searchParams];
  const allowed = settings.every(([name, value]) => Object.hasOwn(rules, name) && rules[name]!.test(value))
    && Object.keys(rules).every((name) => url.searchParams.has(name));
  if (!allowed) return new Response('Unsupported settings', { status: 400 });

  if (options.rateLimit && !await options.rateLimit(clientIp(request.headers))) {
    return new Response('Too many requests', { status: 429 });
  }

  const upstreamUrl = new URL(`https://api.sarvam.ai/${path}`);
  for (const [name, value] of settings) upstreamUrl.searchParams.set(name, value);
  const upstream = await options.connectUpstream(upstreamUrl.toString(), apiKey).catch(() => undefined);
  if (!upstream) return new Response('Sarvam is unavailable', { status: 502 });

  const { client, server } = options.accept();
  relaySockets(server, upstream, options.timers);
  return options.respond(client);
}
