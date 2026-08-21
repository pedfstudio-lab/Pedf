import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleSarvamProxy,
  SARVAM_PROXY_MAX_BODY_BYTES,
  SARVAM_PROXY_PATHS,
} from './sarvamProxy';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleSarvamProxy', () => {
  it('forwards an allowed multipart request with the server key and returns the upstream response', async () => {
    const boundary = '----desipdf-boundary';
    const body = `--${boundary}\r\ncontent\r\n--${boundary}--`;
    const request = new Request('https://app.example/api/sarvam/speech-to-text', {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        origin: 'https://app.example',
        cookie: 'session=private',
        host: 'app.example',
      },
      body,
    });
    const upstreamHeaders = new Headers({
      'content-type': 'application/json',
      'content-length': '22',
      'set-cookie': 'upstream=private',
      'api-subscription-key': 'must-not-return',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(url).toBe('https://api.sarvam.ai/speech-to-text');
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe('POST');
      expect(headers.get('content-type')).toBe(`multipart/form-data; boundary=${boundary}`);
      expect(headers.get('api-subscription-key')).toBe('server-test-key');
      expect(headers.has('cookie')).toBe(false);
      expect(headers.has('host')).toBe(false);
      expect(headers.has('origin')).toBe(false);
      expect(await new Response(init?.body).text()).toBe(body);
      return new Response('{"transcript":"okay"}', {
        status: 201,
        headers: upstreamHeaders,
      });
    });

    const response = await handleSarvamProxy(request, {
      apiKey: 'server-test-key',
      allowedOrigins: ['https://app.example'],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('{"transcript":"okay"}');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('content-length')).toBe('22');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(response.headers.has('api-subscription-key')).toBe(false);
    expect([...response.headers.values()]).not.toContain('server-test-key');
  });

  it('allows exactly the three client proxy paths', () => {
    expect(SARVAM_PROXY_PATHS).toEqual([
      'text-to-speech',
      'speech-to-text',
      'v1/chat/completions',
    ]);
  });

  it('rejects a disallowed path without calling upstream', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const response = await handleSarvamProxy(
      new Request('https://app.example/api/sarvam/anything-else', { method: 'POST' }),
      { apiKey: 'server-test-key' },
    );

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-POST requests', async () => {
    const response = await handleSarvamProxy(
      new Request('https://app.example/api/sarvam/text-to-speech', { method: 'GET' }),
      { apiKey: 'server-test-key' },
    );

    expect(response.status).toBe(405);
  });

  it('rejects an oversized declared body', async () => {
    const response = await handleSarvamProxy(
      new Request('https://app.example/api/sarvam/speech-to-text', {
        method: 'POST',
        headers: { 'content-length': String(SARVAM_PROXY_MAX_BODY_BYTES + 1) },
      }),
      { apiKey: 'server-test-key' },
    );

    expect(response.status).toBe(413);
  });

  it('rejects a missing or disallowed origin when an allowlist is configured', async () => {
    const disallowed = await handleSarvamProxy(
      new Request('https://app.example/api/sarvam/text-to-speech', {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
      { apiKey: 'server-test-key', allowedOrigins: ['https://app.example'] },
    );
    const missing = await handleSarvamProxy(
      new Request('https://app.example/api/sarvam/text-to-speech', { method: 'POST' }),
      { apiKey: 'server-test-key', allowedOrigins: ['https://app.example'] },
    );

    expect(disallowed.status).toBe(403);
    expect(missing.status).toBe(403);
  });

  it('uses the connecting IP with the injectable rate-limit hook', async () => {
    const rateLimit = vi.fn(async () => false);
    const response = await handleSarvamProxy(
      new Request('https://app.example/api/sarvam/v1/chat/completions', {
        method: 'POST',
        headers: { 'cf-connecting-ip': '203.0.113.7' },
      }),
      { apiKey: 'server-test-key', rateLimit },
    );

    expect(rateLimit).toHaveBeenCalledWith('203.0.113.7');
    expect(response.status).toBe(429);
  });

  it('fails closed when the server key is not configured', async () => {
    const response = await handleSarvamProxy(
      new Request('https://app.example/api/sarvam/text-to-speech', { method: 'POST' }),
      { apiKey: '   ' },
    );

    expect(response.status).toBe(503);
  });
});
