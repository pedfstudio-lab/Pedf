import type { ProviderConfig } from './config';
import { providerConfig } from './config';
import { buildDiscussMessages, NOT_IN_DOCUMENT_MARKER } from './discussPrompt';
import { NotImplementedError } from './errors';
import type { ProviderMethod, ProviderWithCapabilities } from './providerTypes';
import type {
  AudioChunkHandler,
  DiscussInput,
  DiscussResult,
  ExplainInput,
  SpeakInput,
  SpeakResult,
  TextResult,
  TranscribeInput,
  TranscribeStreamInput,
  TranscribeStreamSession,
  TranslateInput,
} from './types';

const SARVAM_METHODS = new Set<ProviderMethod>([
  'translate',
  'explain',
  'speak',
  'transcribe',
  'discuss',
]);

const CHAT_MODEL = 'sarvam-105b-conversations';
const CHAT_MAX_TOKENS = 600;
const SPOKEN_CHAT_MAX_TOKENS = 120;
const TTS_MODEL = 'bulbul:v3';
const TTS_MAX_CHARS = 2500;
const TTS_SPEAKER = 'ritu';   // default Bulbul v3 voice (SpeakInput.voice overrides per call)
const TTS_PACE = 1.15;        // 1.0 = normal; higher = faster (bulbul:v3 range 0.5–2.0)
// MP3 is the most broadly MediaSource-compatible Sarvam streaming container.
// Use Sarvam's maximum documented lossy bitrate and streaming sample rate.
const TTS_STREAM_CODEC = 'mp3';
const TTS_STREAM_BITRATE = '256k';
const TTS_STREAM_SAMPLE_RATE = 24_000;
const STT_REALTIME_MODEL = 'saaras:v3-realtime';
const STT_REALTIME_SAMPLE_RATE = 16_000;
const STT_FINAL_TIMEOUT_MS = 2_500;
const STT_KEEPALIVE_MS = 15_000;

type WebSocketFactory = (url: string, protocols: readonly string[]) => WebSocket;

interface SarvamChatResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown };
  }[];
  readonly error?: { readonly message?: unknown };
}

interface SarvamChatStreamChunk {
  readonly choices?: readonly {
    readonly delta?: { readonly content?: unknown };
  }[];
}

interface SarvamTtsResponse {
  readonly audios?: readonly unknown[];
}

interface SarvamTtsStreamMessage {
  readonly type?: unknown;
  readonly data?: {
    readonly audio?: unknown;
    readonly event_type?: unknown;
    readonly message?: unknown;
  };
}

interface SarvamSttResponse {
  readonly transcript?: unknown;
}

interface SarvamRealtimeSttMessage {
  readonly event?: unknown;
  readonly text?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  readonly is_fatal?: unknown;
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(base64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function streamingTtsUrl(base: string): string {
  const url = new URL(joinUrl(base, '/text-to-speech/ws'));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('model', TTS_MODEL);
  url.searchParams.set('send_completion_event', 'true');
  return url.toString();
}

function streamingSttUrl(base: string, language: string): string {
  const url = new URL(joinUrl(base, '/speech-to-text-realtime/ws'));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('language_code', language === 'od-IN' ? 'or-IN' : language);
  url.searchParams.set('model', STT_REALTIME_MODEL);
  url.searchParams.set('stream_type', 'fast');
  url.searchParams.set('mode', 'transcribe');
  url.searchParams.set('endpointing', 'manual');
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', String(STT_REALTIME_SAMPLE_RATE));
  return url.toString();
}

function abortError(): DOMException {
  return new DOMException('Speech streaming was stopped.', 'AbortError');
}

function realtimeSttError(
  message: string,
  retryable: boolean,
  code?: string | number,
): Error & { readonly retryable: boolean; readonly code?: string | number } {
  return Object.assign(new Error(message), {
    retryable,
    ...(code === undefined ? {} : { code }),
  });
}

function normalizeRealtimeTranscript(text: string): string {
  return text
    .replace(/["“”„«»]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary);
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json() as SarvamChatResponse;
    if (typeof payload.error?.message === 'string') return payload.error.message;
  } catch {
    // The status code still provides a useful error if the body is not JSON.
  }
  return response.statusText || 'request failed';
}

/** Decode Sarvam's OpenAI-compatible SSE chat stream and return the assembled answer. */
export async function readChatCompletionStream(
  response: Response,
  onTextDelta: (delta: string) => void,
): Promise<string> {
  if (!response.body) throw new Error('Sarvam returned an empty chat stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let finished = false;

  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice('data:'.length).trim();
    if (data === '[DONE]') {
      finished = true;
      return;
    }
    if (data === '') return;

    let chunk: SarvamChatStreamChunk;
    try {
      chunk = JSON.parse(data) as SarvamChatStreamChunk;
    } catch {
      throw new Error('Sarvam returned an invalid chat stream event.');
    }
    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content !== 'string' || content === '') return;
    answer += content;
    onTextDelta(content);
  };

  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      consumeLine(line);
      if (finished) break;
    }
  }
  buffer += decoder.decode();
  if (!finished && buffer.trim() !== '') consumeLine(buffer);
  return answer;
}

/** Sarvam API provider; translation and transcription arrive in later tasks. */
export class SarvamProvider implements ProviderWithCapabilities {
  readonly name = 'Sarvam';

  constructor(
    readonly config: ProviderConfig = providerConfig,
    private readonly createWebSocket: WebSocketFactory = (url, protocols) => (
      new WebSocket(url, [...protocols])
    ),
  ) {}

  supports(method: ProviderMethod): boolean {
    return SARVAM_METHODS.has(method);
  }

  async translate(input: TranslateInput): Promise<TextResult> {
    void input;
    throw new NotImplementedError(this.name, 'translate');
  }

  async explain(input: ExplainInput): Promise<TextResult> {
    void input;
    throw new NotImplementedError(this.name, 'explain');
  }

  async speak(input: SpeakInput): Promise<SpeakResult> {
    // Security boundary: direct mode reads the key only through provider config.
    const key = this.config.getSarvamKey().trim();
    if (this.config.mode === 'direct' && key === '') {
      throw new Error('Add your Sarvam API key in Settings before playing audio.');
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.mode === 'direct') headers['api-subscription-key'] = key;

    const response = await fetch(joinUrl(this.config.sarvamBaseUrl, '/text-to-speech'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text: input.text.slice(0, TTS_MAX_CHARS),
        target_language_code: input.language,
        model: TTS_MODEL,
        speaker: input.voice ?? TTS_SPEAKER,
        pace: TTS_PACE,
      }),
    });

    if (!response.ok) {
      const detail = await readErrorMessage(response);
      throw new Error(`Sarvam TTS failed (${response.status}): ${detail}`);
    }

    const payload = await response.json() as SarvamTtsResponse;
    const encodedAudio = payload.audios?.[0];
    if (typeof encodedAudio !== 'string' || encodedAudio === '') {
      throw new Error('Sarvam returned no audio.');
    }

    return {
      audio: new Blob([base64ToBytes(encodedAudio)], { type: 'audio/wav' }),
      provider: this.name,
    };
  }

  /** Stream Bulbul v3 MP3 bytes as Sarvam synthesizes them. Batch speak() remains the fallback. */
  async speakStream(
    input: SpeakInput,
    onAudioChunk: AudioChunkHandler,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.config.mode !== 'direct') {
      throw new Error('Streaming TTS needs WebSocket proxy support in production.');
    }

    const key = this.config.getSarvamKey().trim();
    if (key === '') {
      throw new Error('Add your Sarvam API key in Settings before playing audio.');
    }
    if (signal?.aborted) throw abortError();

    await new Promise<void>((resolve, reject) => {
      let socket: WebSocket;
      try {
        // Browser WebSockets cannot set custom headers. Sarvam's JS SDK sends the key
        // through this WebSocket subprotocol in direct mode.
        socket = this.createWebSocket(
          streamingTtsUrl(this.config.sarvamBaseUrl),
          [`api-subscription-key.${key}`],
        );
      } catch (error) {
        reject(error);
        return;
      }

      let settled = false;
      let receivedFinalEvent = false;

      const cleanup = () => {
        signal?.removeEventListener('abort', handleAbort);
        socket.removeEventListener('open', handleOpen);
        socket.removeEventListener('message', handleMessage);
        socket.removeEventListener('error', handleError);
        socket.removeEventListener('close', handleClose);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          socket.close(1000, 'stream failed');
        } catch {
          // The original error is more useful than a close failure.
        }
        reject(error);
      };
      const handleAbort = () => fail(abortError());
      const handleOpen = () => {
        try {
          socket.send(JSON.stringify({
            type: 'config',
            data: {
              model: TTS_MODEL,
              target_language_code: input.language,
              speaker: input.voice ?? TTS_SPEAKER,
              pace: TTS_PACE,
              output_audio_codec: TTS_STREAM_CODEC,
              output_audio_bitrate: TTS_STREAM_BITRATE,
              speech_sample_rate: TTS_STREAM_SAMPLE_RATE,
            },
          }));
          socket.send(JSON.stringify({
            type: 'text',
            data: { text: input.text.slice(0, TTS_MAX_CHARS) },
          }));
          socket.send(JSON.stringify({ type: 'flush' }));
        } catch (error) {
          fail(error);
        }
      };
      const handleMessage = (event: MessageEvent<unknown>) => {
        try {
          if (typeof event.data !== 'string') {
            throw new Error('Sarvam returned an invalid streaming TTS event.');
          }
          const message = JSON.parse(event.data) as SarvamTtsStreamMessage;
          if (message.type === 'audio') {
            const encodedAudio = message.data?.audio;
            if (typeof encodedAudio !== 'string' || encodedAudio === '') {
              throw new Error('Sarvam returned an empty streaming audio chunk.');
            }
            onAudioChunk(base64ToBytes(encodedAudio));
            return;
          }
          if (message.type === 'error') {
            const detail = typeof message.data?.message === 'string'
              ? message.data.message
              : 'streaming request failed';
            fail(new Error(`Sarvam streaming TTS failed: ${detail}`));
            return;
          }
          if (message.type === 'event' && message.data?.event_type === 'final') {
            receivedFinalEvent = true;
            socket.close(1000, 'complete');
          }
        } catch (error) {
          fail(error);
        }
      };
      const handleError = () => fail(new Error('Sarvam streaming TTS connection failed.'));
      const handleClose = (event: CloseEvent) => {
        if (settled) return;
        if (receivedFinalEvent || event.code === 1000) {
          succeed();
          return;
        }
        fail(new Error(`Sarvam streaming TTS closed unexpectedly (${event.code}).`));
      };

      signal?.addEventListener('abort', handleAbort, { once: true });
      socket.addEventListener('open', handleOpen);
      socket.addEventListener('message', handleMessage);
      socket.addEventListener('error', handleError);
      socket.addEventListener('close', handleClose);
    });
  }

  /** Open a persistent Saaras realtime session and accept 16 kHz mono PCM frames. */
  transcribeStream(input: TranscribeStreamInput = {}): TranscribeStreamSession {
    if (this.config.mode !== 'direct') {
      throw new Error('Streaming STT needs WebSocket proxy support in production.');
    }

    const key = this.config.getSarvamKey().trim();
    if (key === '') {
      throw new Error('Add your Sarvam API key in Settings before using the mic.');
    }
    if (input.signal?.aborted) throw abortError();

    const socket = this.createWebSocket(
      streamingSttUrl(this.config.sarvamBaseUrl, input.language ?? 'auto'),
      [`api-subscription-key.${key}`],
    );
    const queuedAudio: Uint8Array<ArrayBuffer>[] = [];
    let opened = false;
    let utteranceStarted = false;
    let finishRequested = false;
    let terminal = false;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    let pendingFinal: {
      readonly promise: Promise<TextResult>;
      readonly resolve: (result: TextResult) => void;
      readonly reject: (error: unknown) => void;
    } | undefined;
    let resolveReady: () => void = () => undefined;
    let rejectReady: (error: unknown) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);

    const cleanup = () => {
      if (finalTimer !== undefined) clearTimeout(finalTimer);
      if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
      input.signal?.removeEventListener('abort', handleAbort);
      socket.removeEventListener('open', handleOpen);
      socket.removeEventListener('message', handleMessage);
      socket.removeEventListener('error', handleError);
      socket.removeEventListener('close', handleClose);
    };
    const closeSocket = (reason: string) => {
      try {
        socket.close(1000, reason);
      } catch {
        // The session result is already settled; close failure is non-actionable.
      }
    };
    const clearFinalTimer = () => {
      if (finalTimer === undefined) return;
      clearTimeout(finalTimer);
      finalTimer = undefined;
    };
    const fail = (error: unknown, report = true) => {
      if (terminal) return;
      terminal = true;
      cleanup();
      rejectReady(error);
      pendingFinal?.reject(error);
      pendingFinal = undefined;
      if (report) input.onError?.(error);
      closeSocket('stream failed');
    };
    const close = () => {
      if (terminal) return;
      terminal = true;
      cleanup();
      const stopped = abortError();
      rejectReady(stopped);
      pendingFinal?.reject(stopped);
      pendingFinal = undefined;
      try {
        if (opened) socket.send(JSON.stringify({ event: 'end' }));
      } catch {
        // Closing is best-effort; resources are released below regardless.
      }
      closeSocket('complete');
    };
    const sendJson = (message: unknown) => {
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        fail(error);
      }
    };
    const startUtterance = () => {
      if (!opened || terminal || utteranceStarted) return;
      utteranceStarted = true;
      sendJson({ event: 'speech_start' });
    };
    const sendEndOfSpeech = () => {
      if (!opened || terminal || !finishRequested) return;
      startUtterance();
      sendJson({ event: 'speech_end' });
      if (!terminal) sendJson({ event: 'flush' });
    };
    const handleAbort = () => close();
    const handleOpen = () => {
      if (terminal) return;
      opened = true;
      resolveReady();
      keepaliveTimer = setInterval(() => {
        if (opened && !terminal) sendJson({ event: 'ping' });
      }, STT_KEEPALIVE_MS);
      for (const audio of queuedAudio.splice(0)) {
        if (terminal) return;
        startUtterance();
        sendJson({ event: 'audio_input', audio: bytesToBase64(audio) });
      }
      sendEndOfSpeech();
    };
    const handleMessage = (event: MessageEvent<unknown>) => {
      try {
        if (typeof event.data !== 'string') {
          throw new Error('Sarvam returned an invalid realtime STT event.');
        }
        const message = JSON.parse(event.data) as SarvamRealtimeSttMessage;
        if (message.event === 'vad.speech_start' || message.event === 'START_SPEECH') {
          input.onSpeechStart?.();
          return;
        }
        if (message.event === 'vad.speech_end' || message.event === 'END_SPEECH') {
          input.onSpeechEnd?.();
          return;
        }
        if (message.event === 'transcript.partial') {
          const text = typeof message.text === 'string'
            ? normalizeRealtimeTranscript(message.text)
            : '';
          if (text !== '') {
            input.onPartial?.(text);
          }
          return;
        }
        if (message.event === 'transcript.final') {
          const text = typeof message.text === 'string'
            ? normalizeRealtimeTranscript(message.text)
            : '';
          if (text === '') throw new Error('Sarvam returned an empty realtime transcript.');
          clearFinalTimer();
          finishRequested = false;
          utteranceStarted = false;
          const completed = pendingFinal;
          pendingFinal = undefined;
          input.onFinal?.(text);
          completed?.resolve({ text, provider: this.name });
          return;
        }
        if (message.event === 'error') {
          const detail = typeof message.message === 'string'
            ? message.message
            : 'realtime request failed';
          const code = typeof message.code === 'string' || typeof message.code === 'number'
            ? ` (${message.code})`
            : '';
          const rawCode = typeof message.code === 'string' || typeof message.code === 'number'
            ? message.code
            : undefined;
          const retryable = message.is_fatal !== true
            && rawCode !== 1003
            && rawCode !== '1003'
            && rawCode !== 4000
            && rawCode !== '4000';
          fail(realtimeSttError(
            `Sarvam streaming STT failed${code}: ${detail}`,
            retryable,
            rawCode,
          ));
        }
      } catch (error) {
        fail(error);
      }
    };
    const handleError = () => fail(realtimeSttError(
      'Sarvam streaming STT connection failed.',
      true,
    ));
    const handleClose = (event: CloseEvent) => {
      if (terminal) return;
      const retryable = event.code < 4000 && event.code !== 1003;
      fail(realtimeSttError(
        `Sarvam streaming STT closed unexpectedly (${event.code}).`,
        retryable,
        event.code,
      ));
    };

    input.signal?.addEventListener('abort', handleAbort, { once: true });
    socket.addEventListener('open', handleOpen);
    socket.addEventListener('message', handleMessage);
    socket.addEventListener('error', handleError);
    socket.addEventListener('close', handleClose);

    return {
      ready,
      pushAudio: (audio) => {
        if (terminal || finishRequested || audio.byteLength === 0) return;
        if (!opened) {
          queuedAudio.push(audio.slice());
          return;
        }
        startUtterance();
        sendJson({ event: 'audio_input', audio: bytesToBase64(audio) });
      },
      finish: () => {
        if (terminal) return Promise.reject(abortError());
        if (pendingFinal) return pendingFinal.promise;
        let resolveFinal: (result: TextResult) => void = () => undefined;
        let rejectFinal: (error: unknown) => void = () => undefined;
        const promise = new Promise<TextResult>((resolve, reject) => {
          resolveFinal = resolve;
          rejectFinal = reject;
        });
        void promise.catch(() => undefined);
        pendingFinal = { promise, resolve: resolveFinal, reject: rejectFinal };
        finishRequested = true;
        sendEndOfSpeech();
        finalTimer = setTimeout(() => {
          fail(realtimeSttError('Sarvam realtime transcript timed out.', true));
        }, STT_FINAL_TIMEOUT_MS);
        return promise;
      },
      close,
    };
  }

  async transcribe(input: TranscribeInput): Promise<TextResult> {
    // Security boundary: direct mode reads the key only through provider config.
    const key = this.config.getSarvamKey().trim();
    if (this.config.mode === 'direct' && key === '') {
      throw new Error('Add your Sarvam API key in Settings before using the mic.');
    }

    const form = new FormData();
    form.append('file', input.audio, 'question.webm');
    if (input.language) form.append('language_code', input.language);

    const headers: Record<string, string> = {};
    if (this.config.mode === 'direct') headers['api-subscription-key'] = key;

    const response = await fetch(joinUrl(this.config.sarvamBaseUrl, '/speech-to-text'), {
      method: 'POST',
      headers,
      body: form,
    });

    if (!response.ok) {
      const detail = await readErrorMessage(response);
      throw new Error(`Sarvam STT failed (${response.status}): ${detail}`);
    }

    const payload = await response.json() as SarvamSttResponse;
    const text = typeof payload.transcript === 'string' ? payload.transcript.trim() : '';
    if (text === '') throw new Error('Sarvam returned an empty transcript.');
    return { text, provider: this.name };
  }

  async discuss(input: DiscussInput): Promise<DiscussResult> {
    // Security boundary: this is the only source of a direct-mode key.
    const key = this.config.getSarvamKey().trim();
    if (this.config.mode === 'direct' && key === '') {
      throw new Error('Add your Sarvam API key in Settings before asking a question.');
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key !== '') headers['api-subscription-key'] = key;

    const stream = typeof input.onTextDelta === 'function';
    const response = await fetch(joinUrl(this.config.sarvamBaseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: buildDiscussMessages(input),
        temperature: 0.2,
        max_tokens: input.spoken ? SPOKEN_CHAT_MAX_TOKENS : CHAT_MAX_TOKENS,
        ...(stream ? { stream: true } : {}),
      }),
    });

    if (!response.ok) {
      const detail = await readErrorMessage(response);
      throw new Error(`Sarvam request failed (${response.status}): ${detail}`);
    }

    let rawAnswer: unknown;
    if (stream && input.onTextDelta) {
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const payload = await response.json() as SarvamChatResponse;
        rawAnswer = payload.choices?.[0]?.message?.content;
        if (typeof rawAnswer === 'string' && rawAnswer !== '') input.onTextDelta(rawAnswer);
      } else {
        rawAnswer = await readChatCompletionStream(response, input.onTextDelta);
      }
    } else {
      const payload = await response.json() as SarvamChatResponse;
      rawAnswer = payload.choices?.[0]?.message?.content;
    }
    if (typeof rawAnswer !== 'string' || rawAnswer.trim() === '') {
      throw new Error('Sarvam returned an empty chat response.');
    }

    const answer = rawAnswer.trim();
    if (answer.startsWith(NOT_IN_DOCUMENT_MARKER)) {
      const withoutMarker = answer.slice(NOT_IN_DOCUMENT_MARKER.length).trim();
      if (withoutMarker === '') throw new Error('Sarvam returned an empty not-in-document response.');
      return { answer: withoutMarker, grounded: false, provider: this.name };
    }
    return { answer, grounded: true, provider: this.name };
  }
}
