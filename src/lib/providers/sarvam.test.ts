import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from './config';
import { NOT_IN_DOCUMENT_MARKER } from './discussPrompt';
import { base64ToBytes, SarvamProvider } from './sarvam';

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

function sseResponse(parts: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

type SocketListener = EventListenerOrEventListenerObject;

class FakeWebSocket {
  readonly listeners = new Map<string, Set<SocketListener>>();
  readonly sent: string[] = [];
  readonly close = vi.fn((code = 1000) => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', { code } as CloseEvent);
  });
  readyState: number = WebSocket.CONNECTING;

  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open', new Event('open'));
  }

  message(data: unknown): void {
    this.emit('message', { data: JSON.stringify(data) } as MessageEvent<string>);
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
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
      messages: readonly { role: string; content: string }[];
    };
    expect(request).toMatchObject({
      model: 'sarvam-105b-conversations',
      temperature: 0.2,
      max_tokens: 600,
    });
    expect(request.messages[0]?.content).toContain('Answer concisely in Hindi');
    expect(request.messages[0]?.content).toContain(input.documentText);
    expect(request.messages[1]).toMatchObject({ role: 'user' });
    expect(request.messages[1]?.content).toContain(input.question);
    expect(request.messages[1]?.content).not.toContain('<DOCUMENT>');
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

  it('uses a smaller token budget and brevity prompt for spoken answers', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: 'Check-in is at 3 PM. [Page 1]' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await new SarvamProvider(directConfig()).discuss({ ...input, spoken: true });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const request = JSON.parse(String(init?.body)) as {
      max_tokens: number;
      messages: readonly { content: string }[];
    };
    expect(request.max_tokens).toBe(120);
    expect(request.messages[0]?.content).toContain('1–2 short sentences');
    expect(request.messages[0]?.content).toContain('no more than 40 words');
  });

  it('streams spoken chat deltas and assembles the final grounded answer', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"Check-in is "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"at 3 PM. [Page 1]"}}]}\n',
      '\ndata: {"choices":[],"usage":{"total_tokens":12}}\n\n',
      'data: [DONE]\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const onTextDelta = vi.fn();

    await expect(new SarvamProvider(directConfig()).discuss({
      ...input,
      spoken: true,
      onTextDelta,
    })).resolves.toEqual({
      answer: 'Check-in is at 3 PM. [Page 1]',
      grounded: true,
      provider: 'Sarvam',
    });

    expect(onTextDelta.mock.calls.map(([delta]) => delta)).toEqual([
      'Check-in is ',
      'at 3 PM. [Page 1]',
    ]);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true });
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

describe('SarvamProvider.speak', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('decodes base64 into the exact bytes', () => {
    expect([...base64ToBytes('AAEC/w==')]).toEqual([0, 1, 2, 255]);
  });

  it('requests Bulbul v3 audio with the configured key and documented language field', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse({ audios: ['AAEC/w=='] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new SarvamProvider(directConfig()).speak({
      text: 'नमस्ते',
      language: 'hi-IN',
      voice: 'priya',
    });

    expect(result.provider).toBe('Sarvam');
    expect(result.audio.type).toBe('audio/wav');
    expect([...new Uint8Array(await result.audio.arrayBuffer())]).toEqual([0, 1, 2, 255]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.sarvam.ai/text-to-speech');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'api-subscription-key': 'configured-test-key',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      text: 'नमस्ते',
      target_language_code: 'hi-IN',
      model: 'bulbul:v3',
      speaker: 'priya',
      pace: 1.15,
    });
  });

  it('clips v3 input to 2500 characters and uses the default Ritu voice + pace', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse({ audios: ['AA=='] }));
    vi.stubGlobal('fetch', fetchMock);

    await new SarvamProvider(directConfig()).speak({
      text: 'a'.repeat(2600),
      language: 'en-IN',
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const request = JSON.parse(String(init?.body)) as { text: string; speaker?: string; pace?: number };
    expect(request.text).toHaveLength(2500);
    expect(request.speaker).toBe('ritu');
    expect(request.pace).toBe(1.15);
  });

  it('rejects an empty direct-mode key without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new SarvamProvider(directConfig('')).speak({
      text: 'Hello',
      language: 'en-IN',
    })).rejects.toThrow('Add your Sarvam API key in Settings before playing audio');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces HTTP failures and an empty audio response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: { message: 'Unsupported language' },
    }, 422)));
    await expect(new SarvamProvider(directConfig()).speak({
      text: 'Hello',
      language: 'en-IN',
    })).rejects.toThrow('Sarvam TTS failed (422): Unsupported language');

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ audios: [] })));
    await expect(new SarvamProvider(directConfig()).speak({
      text: 'Hello',
      language: 'en-IN',
    })).rejects.toThrow('Sarvam returned no audio');
  });

  it('leaves authentication to the production proxy', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse({ audios: ['AA=='] }));
    vi.stubGlobal('fetch', fetchMock);
    const config: ProviderConfig = {
      mode: 'proxy',
      sarvamBaseUrl: '/api/sarvam',
      getSarvamKey: () => 'must-not-leave-the-browser',
    };

    await new SarvamProvider(config).speak({ text: 'Hello', language: 'en-IN' });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/sarvam/text-to-speech');
    expect(init?.headers).not.toHaveProperty('api-subscription-key');
  });
});

describe('SarvamProvider.speakStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('authenticates through the socket protocol and streams Bulbul v3 MP3 chunks', async () => {
    vi.stubGlobal('WebSocket', { CONNECTING: 0, OPEN: 1, CLOSED: 3 });
    const socket = new FakeWebSocket();
    const factory = vi.fn((url: string, protocols: readonly string[]) => {
      void url;
      void protocols;
      return socket as unknown as WebSocket;
    });
    const provider = new SarvamProvider(directConfig(), factory);
    const chunks: Uint8Array<ArrayBuffer>[] = [];

    const completion = provider.speakStream(
      { text: 'Hello there', language: 'en-IN', voice: 'priya' },
      (audio) => chunks.push(audio),
    );
    socket.open();

    expect(factory).toHaveBeenCalledOnce();
    const [rawUrl, protocols] = factory.mock.calls[0] ?? [];
    const url = new URL(String(rawUrl));
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
      'wss://api.sarvam.ai/text-to-speech/ws',
    );
    expect(url.searchParams.get('model')).toBe('bulbul:v3');
    expect(url.searchParams.get('send_completion_event')).toBe('true');
    expect(protocols).toEqual(['api-subscription-key.configured-test-key']);

    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      {
        type: 'config',
        data: {
          model: 'bulbul:v3',
          target_language_code: 'en-IN',
          speaker: 'priya',
          pace: 1.15,
          output_audio_codec: 'mp3',
          output_audio_bitrate: '128k',
        },
      },
      { type: 'text', data: { text: 'Hello there' } },
      { type: 'flush' },
    ]);

    socket.message({
      type: 'audio',
      data: { content_type: 'audio/mpeg', audio: 'AQID' },
    });
    socket.message({ type: 'event', data: { event_type: 'final' } });

    await expect(completion).resolves.toBeUndefined();
    expect([...chunks[0] ?? []]).toEqual([1, 2, 3]);
    expect(socket.close).toHaveBeenCalledWith(1000, 'complete');
  });

  it('stops and rejects the socket stream when playback is aborted', async () => {
    vi.stubGlobal('WebSocket', { CONNECTING: 0, OPEN: 1, CLOSED: 3 });
    const socket = new FakeWebSocket();
    const controller = new AbortController();
    const provider = new SarvamProvider(
      directConfig(),
      () => socket as unknown as WebSocket,
    );
    const completion = provider.speakStream(
      { text: 'Stop me', language: 'en-IN' },
      vi.fn(),
      controller.signal,
    );
    socket.open();
    controller.abort();

    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    expect(socket.close).toHaveBeenCalledWith(1000, 'stream failed');
  });

  it('keeps proxy mode on the existing REST batch fallback until WS proxying lands', async () => {
    const factory = vi.fn();
    const config: ProviderConfig = {
      mode: 'proxy',
      sarvamBaseUrl: '/api/sarvam',
      getSarvamKey: () => 'must-not-leave-the-browser',
    };

    await expect(new SarvamProvider(config, factory).speakStream(
      { text: 'Hello', language: 'en-IN' },
      vi.fn(),
    )).rejects.toThrow('WebSocket proxy support');
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('SarvamProvider.transcribeStream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('queues PCM until open and resolves partial and final realtime transcripts', async () => {
    vi.stubGlobal('WebSocket', { CONNECTING: 0, OPEN: 1, CLOSED: 3 });
    const socket = new FakeWebSocket();
    const factory = vi.fn((url: string, protocols: readonly string[]) => {
      void url;
      void protocols;
      return socket as unknown as WebSocket;
    });
    const onPartial = vi.fn();
    const session = new SarvamProvider(directConfig(), factory).transcribeStream({
      language: 'hi-IN',
      onPartial,
    });
    const frame = new Uint8Array(new ArrayBuffer(4));
    frame.set([0, 1, 2, 3]);
    session.pushAudio(frame);

    socket.open();
    await expect(session.ready).resolves.toBeUndefined();

    const [rawUrl, protocols] = factory.mock.calls[0] ?? [];
    const url = new URL(String(rawUrl));
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
      'wss://api.sarvam.ai/speech-to-text-realtime/ws',
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      language_code: 'hi-IN',
      model: 'saaras:v3-realtime',
      stream_type: 'fast',
      mode: 'transcribe',
      endpointing: 'manual',
      encoding: 'linear16',
      sample_rate: '16000',
    });
    expect(protocols).toEqual(['api-subscription-key.configured-test-key']);
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { event: 'speech_start' },
      { event: 'audio_input', audio: 'AAECAw==' },
    ]);

    socket.message({ event: 'transcript.partial', text: ' क्या समय ' });
    expect(onPartial).toHaveBeenCalledWith('क्या समय');
    const completed = session.finish();
    expect(socket.sent.slice(-2).map((message) => JSON.parse(message))).toEqual([
      { event: 'speech_end' },
      { event: 'flush' },
    ]);
    socket.message({ event: 'transcript.final', text: ' क्या समय है? ' });

    await expect(completed).resolves.toEqual({ text: 'क्या समय है?', provider: 'Sarvam' });
    expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toEqual({ event: 'end' });
    expect(socket.close).toHaveBeenCalledWith(1000, 'complete');
  });

  it('cancels the realtime socket through the shared abort path', async () => {
    vi.stubGlobal('WebSocket', { CONNECTING: 0, OPEN: 1, CLOSED: 3 });
    const socket = new FakeWebSocket();
    const session = new SarvamProvider(
      directConfig(),
      () => socket as unknown as WebSocket,
    ).transcribeStream();
    socket.open();

    const completed = session.finish();
    session.cancel();

    await expect(completed).rejects.toMatchObject({ name: 'AbortError' });
    expect(socket.close).toHaveBeenCalledWith(1000, 'stream failed');
  });

  it('surfaces connection failure so recording can select its batch fallback', async () => {
    vi.stubGlobal('WebSocket', { CONNECTING: 0, OPEN: 1, CLOSED: 3 });
    const socket = new FakeWebSocket();
    const session = new SarvamProvider(
      directConfig(),
      () => socket as unknown as WebSocket,
    ).transcribeStream();
    const completed = session.finish();

    socket.close(4401);

    await expect(session.ready).rejects.toThrow('closed unexpectedly (4401)');
    await expect(completed).rejects.toThrow('closed unexpectedly (4401)');
  });

  it('rejects a missing key before opening a socket', () => {
    const factory = vi.fn();

    expect(() => new SarvamProvider(directConfig(''), factory).transcribeStream()).toThrow(
      'Add your Sarvam API key in Settings',
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('leaves proxy mode on the batch fallback until WebSocket proxying lands', () => {
    const factory = vi.fn();
    const config: ProviderConfig = {
      mode: 'proxy',
      sarvamBaseUrl: '/api/sarvam',
      getSarvamKey: () => 'must-not-leave-the-browser',
    };

    expect(() => new SarvamProvider(config, factory).transcribeStream()).toThrow(
      'WebSocket proxy support',
    );
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('SarvamProvider.transcribe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads browser audio as multipart without overriding its content type', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse({ transcript: '  what are the dates?  ' }));
    vi.stubGlobal('fetch', fetchMock);
    const audio = new Blob(['webm-audio'], { type: 'audio/webm;codecs=opus' });

    await expect(new SarvamProvider(directConfig()).transcribe({ audio })).resolves.toEqual({
      text: 'what are the dates?',
      provider: 'Sarvam',
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.sarvam.ai/speech-to-text');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'api-subscription-key': 'configured-test-key' });
    expect(init?.headers).not.toHaveProperty('Content-Type');
    const form = init?.body as FormData;
    const file = form.get('file') as File;
    expect(file.name).toBe('question.webm');
    expect(file.type).toBe('audio/webm;codecs=opus');
    expect(file.size).toBe(audio.size);
    expect(form.get('language_code')).toBeNull();
    expect(form.get('model')).toBeNull();
  });

  it('includes language_code only when the caller supplies it', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse({ transcript: 'नमस्ते' }));
    vi.stubGlobal('fetch', fetchMock);

    await new SarvamProvider(directConfig()).transcribe({
      audio: new Blob(['voice'], { type: 'audio/webm' }),
      language: 'hi-IN',
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init?.body as FormData).get('language_code')).toBe('hi-IN');
  });

  it('rejects an empty direct-mode key without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new SarvamProvider(directConfig('')).transcribe({
      audio: new Blob(['voice']),
    })).rejects.toThrow('Add your Sarvam API key in Settings before using the mic');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces HTTP failures and an empty transcript', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      error: { message: 'Invalid audio' },
    }, 422)));
    await expect(new SarvamProvider(directConfig()).transcribe({
      audio: new Blob(['voice']),
    })).rejects.toThrow('Sarvam STT failed (422): Invalid audio');

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ transcript: '   ' })));
    await expect(new SarvamProvider(directConfig()).transcribe({
      audio: new Blob(['voice']),
    })).rejects.toThrow('Sarvam returned an empty transcript');
  });

  it('leaves authentication to the production proxy', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(jsonResponse({ transcript: 'Hello' }));
    vi.stubGlobal('fetch', fetchMock);
    const config: ProviderConfig = {
      mode: 'proxy',
      sarvamBaseUrl: '/api/sarvam',
      getSarvamKey: () => 'must-not-leave-the-browser',
    };

    await new SarvamProvider(config).transcribe({ audio: new Blob(['voice']) });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/sarvam/speech-to-text');
    expect(init?.headers).not.toHaveProperty('api-subscription-key');
  });
});
