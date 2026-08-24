import type { ProviderConfig } from './config';
import { providerConfig } from './config';
import { buildDiscussMessages, NOT_IN_DOCUMENT_MARKER } from './discussPrompt';
import { NotImplementedError } from './errors';
import type { ProviderMethod, ProviderWithCapabilities } from './providerTypes';
import type {
  DiscussInput,
  DiscussResult,
  ExplainInput,
  SpeakInput,
  SpeakResult,
  TextResult,
  TranscribeInput,
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

interface SarvamSttResponse {
  readonly transcript?: unknown;
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

  constructor(readonly config: ProviderConfig = providerConfig) {}

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
