import { describe, expect, it, vi } from 'vitest';
import {
  handleSarvamSocket,
  isSarvamSocketPath,
  relaySockets,
  SOCKET_IDLE_MS,
  SOCKET_MAX_MS,
  type RelaySocket,
  type SarvamSocketOptions,
  type SocketTimers,
} from './sarvamSocket';

const LIVE = 'https://highpal.ai';
const STT = 'speech-to-text-realtime/ws?language_code=hi-IN&model=saaras%3Av3-realtime&stream_type=fast&mode=transcribe&endpointing=manual&encoding=linear16&sample_rate=16000';
const TTS = 'text-to-speech/ws?model=bulbul%3Av3&send_completion_event=true';

class FakeSocket implements RelaySocket {
  readonly sent: unknown[] = [];
  readonly closed: { code?: number; reason?: string }[] = [];
  private readonly listeners = new Map<string, ((event: never) => void)[]>();
  send(data: unknown): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closed.push({ code, reason }); }
  addEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: object): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

class FakeTimers implements SocketTimers {
  private next = 0;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();
  set(callback: () => void, ms: number): number { this.pending.set(++this.next, { callback, ms }); return this.next; }
  clear(id: unknown): void { this.pending.delete(id as number); }
  fire(ms: number): void { for (const [id, timer] of [...this.pending]) if (timer.ms === ms) { this.pending.delete(id); timer.callback(); } }
}

function setup(overrides: Partial<SarvamSocketOptions> = {}) {
  const upstream = new FakeSocket(), server = new FakeSocket(), timers = new FakeTimers();
  const connectUpstream = vi.fn(async () => upstream as RelaySocket);
  const respond = vi.fn(() => new Response(null, { status: 200, headers: { 'x-fake-101': 'yes' } }));
  const options: SarvamSocketOptions = {
    apiKey: 'server-secret', allowedOrigins: [LIVE], connectUpstream,
    accept: () => ({ client: 'browser-side', server }), respond, timers, ...overrides,
  };
  return { upstream, server, timers, connectUpstream, respond, options };
}

const open = (path: string, origin = LIVE, upgrade = 'websocket') => new Request(`${LIVE}/api/sarvam/${path}`, {
  headers: { upgrade, origin, 'cf-connecting-ip': '198.51.100.4' },
});

describe('Sarvam route: live connections (Conversation, spoken answers)', () => {
  it('opens Sarvam with the key in a header, never in the address, and hands the browser its side', async () => {
    const { options, connectUpstream, respond } = setup();
    const response = await handleSarvamSocket(open(STT), options);

    expect(response.headers.get('x-fake-101')).toBe('yes');
    expect(respond).toHaveBeenCalledWith('browser-side');
    const [url, key] = connectUpstream.mock.calls[0]! as unknown as [string, string];
    expect(url.startsWith('https://api.sarvam.ai/speech-to-text-realtime/ws?')).toBe(true);
    expect(new URL(url).searchParams.get('model')).toBe('saaras:v3-realtime');
    expect(url).not.toContain('server-secret');
    expect(key).toBe('server-secret');
  });

  it('allows the spoken-answer connection too', async () => {
    const { options, connectUpstream } = setup();
    await handleSarvamSocket(open(TTS), options);
    expect((connectUpstream.mock.calls[0]! as unknown as [string])[0].startsWith('https://api.sarvam.ai/text-to-speech/ws?')).toBe(true);
  });

  it.each([
    ['another website', () => open(STT, 'https://someone-else.example'), 403],
    ['a plain request instead of a live connection', () => open(STT, LIVE, ''), 426],
    ['an unknown Sarvam address', () => open('speech-to-text/ws?model=x'), 404],
    ['a built-in name as the address', () => open('constructor'), 404],
    ['a different, possibly costlier model', () => open(STT.replace('saaras%3Av3-realtime', 'saaras%3Av3-pro')), 400],
    ['an extra setting', () => open(`${TTS}&speaker=anyone`), 400],
    ['a missing setting', () => open('text-to-speech/ws?send_completion_event=true'), 400],
  ])('refuses %s without touching Sarvam', async (_label, request, status) => {
    const { options, connectUpstream } = setup();
    expect((await handleSarvamSocket(request(), options)).status).toBe(status);
    expect(connectUpstream).not.toHaveBeenCalled();
  });

  it('says "not set up" when the secret is missing, and counts each connection toward the limit', async () => {
    const missing = setup({ apiKey: '' });
    expect((await handleSarvamSocket(open(STT), missing.options)).status).toBe(503);

    const limit = vi.fn(async () => false);
    const limited = setup({ rateLimit: limit });
    expect((await handleSarvamSocket(open(STT), limited.options)).status).toBe(429);
    expect(limit).toHaveBeenCalledWith('198.51.100.4');
    expect(limited.connectUpstream).not.toHaveBeenCalled();
  });

  it('reports Sarvam refusing the connection as unavailable', async () => {
    const { options } = setup({ connectUpstream: async () => undefined });
    expect((await handleSarvamSocket(open(STT), options)).status).toBe(502);
  });

  it('knows exactly which addresses are live connections', () => {
    expect(isSarvamSocketPath('/api/sarvam/speech-to-text-realtime/ws')).toBe(true);
    expect(isSarvamSocketPath('/api/sarvam/text-to-speech/ws')).toBe(true);
    expect(isSarvamSocketPath('/api/sarvam/translate')).toBe(false);
    expect(isSarvamSocketPath('/api/sarvam/toString')).toBe(false);
  });
});

describe('relaySockets', () => {
  it('passes voice and answers both ways unchanged', () => {
    const browser = new FakeSocket(), sarvam = new FakeSocket();
    relaySockets(browser, sarvam, new FakeTimers());
    browser.emit('message', { data: '{"audio":"..."}' });
    sarvam.emit('message', { data: '{"transcript":"नमस्ते"}' });
    expect(sarvam.sent).toEqual(['{"audio":"..."}']);
    expect(browser.sent).toEqual(['{"transcript":"नमस्ते"}']);
  });

  it('closes both sides when either side closes, passing on Sarvam\'s reason', () => {
    const browser = new FakeSocket(), sarvam = new FakeSocket();
    relaySockets(browser, sarvam, new FakeTimers());
    sarvam.emit('close', { code: 4001, reason: 'Invalid audio' });
    expect(browser.closed).toEqual([{ code: 4001, reason: 'Invalid audio' }]);
    expect(sarvam.closed).toHaveLength(1);
    browser.emit('close', { code: 1000 });
    expect(browser.closed).toHaveLength(1);
  });

  it('never sends a reserved close code the browser would reject', () => {
    const browser = new FakeSocket(), sarvam = new FakeSocket();
    relaySockets(browser, sarvam, new FakeTimers());
    sarvam.emit('close', { code: 1006 });
    expect(browser.closed[0]!.code).toBe(1000);
  });

  it('ends a conversation after 10 minutes, so an open connection cannot drain the credits', () => {
    const browser = new FakeSocket(), sarvam = new FakeSocket(), timers = new FakeTimers();
    relaySockets(browser, sarvam, timers);
    browser.emit('message', { data: 'audio' });
    timers.fire(SOCKET_MAX_MS);
    expect(browser.closed[0]).toEqual({ code: 4000, reason: 'Conversation time limit reached' });
    expect(sarvam.closed).toHaveLength(1);
    expect(timers.pending.size).toBe(0);
  });

  it('closes after a quiet minute, but every message from the browser restarts the count', () => {
    const browser = new FakeSocket(), sarvam = new FakeSocket(), timers = new FakeTimers();
    relaySockets(browser, sarvam, timers);
    browser.emit('message', { data: 'keep-alive' });
    expect([...timers.pending.values()].filter((timer) => timer.ms === SOCKET_IDLE_MS)).toHaveLength(1);
    timers.fire(SOCKET_IDLE_MS);
    expect(browser.closed[0]).toEqual({ code: 4008, reason: 'Closed after a quiet minute' });
  });
});
