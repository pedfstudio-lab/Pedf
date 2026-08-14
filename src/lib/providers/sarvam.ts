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

interface SarvamChatResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown };
  }[];
  readonly error?: { readonly message?: unknown };
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

/** Sarvam API provider; speech and translation calls arrive in later tasks. */
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
    void input;
    throw new NotImplementedError(this.name, 'speak');
  }

  async transcribe(input: TranscribeInput): Promise<TextResult> {
    void input;
    throw new NotImplementedError(this.name, 'transcribe');
  }

  async discuss(input: DiscussInput): Promise<DiscussResult> {
    // Security boundary: this is the only source of a direct-mode key.
    const key = this.config.getSarvamKey().trim();
    if (this.config.mode === 'direct' && key === '') {
      throw new Error('Add your Sarvam API key in Settings before asking a question.');
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key !== '') headers['api-subscription-key'] = key;

    const response = await fetch(joinUrl(this.config.sarvamBaseUrl, '/v1/chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: buildDiscussMessages(input),
        temperature: 0.2,
        max_tokens: 600,
      }),
    });

    if (!response.ok) {
      const detail = await readErrorMessage(response);
      throw new Error(`Sarvam request failed (${response.status}): ${detail}`);
    }

    const payload = await response.json() as SarvamChatResponse;
    const rawAnswer = payload.choices?.[0]?.message?.content;
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
