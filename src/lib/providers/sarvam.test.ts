import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from './config';
import { NOT_IN_DOCUMENT_MARKER } from './discussPrompt';
import { SarvamProvider } from './sarvam';

const input = {
  question: 'What time is check-in?',
  documentText: '[Page 1]\nCheck-in is at 3 PM.',
  language: 'hi-IN',
};

function directConfig(key = 'configured-test-key'): ProviderConfig {
  return {
    mode: 'direct',
    sarvamBaseUrl: 'https://api.sarvam.ai',
    getSarvamKey: () => key,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SarvamProvider.discuss', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the configured key and grounded prompt to the supported chat model', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'Check-in is at 3 PM. [Page 1]' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new SarvamProvider(directConfig()).discuss(input)).resolves.toEqual({
      answer: 'Check-in is at 3 PM. [Page 1]',
      grounded: true,
      provider: 'Sarvam',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.sarvam.ai/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'api-subscription-key': 'configured-test-key',
    });
    const request = JSON.parse(String(init?.body)) as {
      model: string;
      temperature: number;
      max_tokens: number;
      messages: readonly { content: string }[];
    };
    expect(request).toMatchObject({
      model: 'sarvam-105b-conversations',
      temperature: 0.2,
      max_tokens: 600,
    });
    expect(request.messages[0]?.content).toContain('Answer concisely in Hindi');
    expect(request.messages[1]?.content).toContain(input.documentText);
    expect(request.messages[1]?.content).toContain(input.question);
  });

  it('marks an explicit not-in-document response as ungrounded and strips the marker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{ message: { content: `${NOT_IN_DOCUMENT_MARKER} यह दस्तावेज़ में नहीं है।` } }],
    })));

    await expect(new SarvamProvider(directConfig()).discuss(input)).resolves.toEqual({
      answer: 'यह दस्तावेज़ में नहीं है।',
      grounded: false,
      provider: 'Sarvam',
    });
  });

  it('rejects an empty direct-mode key without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new SarvamProvider(directConfig('')).discuss(input)).rejects.toThrow(
      'Add your Sarvam API key in Settings',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces HTTP and empty-response failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: { message: 'Invalid request' },
    }, 400)));
    await expect(new SarvamProvider(directConfig()).discuss(input)).rejects.toThrow(
      'Sarvam request failed (400): Invalid request',
    );

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [] })));
    await expect(new SarvamProvider(directConfig()).discuss(input)).rejects.toThrow(
      'Sarvam returned an empty chat response',
    );
  });

  it('leaves authentication to the production proxy', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'Server-authenticated answer' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const config: ProviderConfig = {
      mode: 'proxy',
      sarvamBaseUrl: '/api/sarvam',
      getSarvamKey: () => '',
    };

    await expect(new SarvamProvider(config).discuss(input)).resolves.toMatchObject({
      grounded: true,
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).not.toHaveProperty('api-subscription-key');
  });
});
