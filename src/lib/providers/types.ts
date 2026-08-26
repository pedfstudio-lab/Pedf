/** BCP-47 language code such as hi-IN, ta-IN, or en-IN; providers may also accept auto. */
export type LanguageCode = string;

export interface TranslateInput {
  readonly text: string;
  readonly to: LanguageCode;
  readonly from?: LanguageCode;
}

export interface ExplainInput {
  readonly text: string;
  readonly language: LanguageCode;
}

export interface SpeakInput {
  readonly text: string;
  readonly language: LanguageCode;
  readonly voice?: string;
}

/** One decoded audio payload from a provider's streaming TTS connection. */
export type AudioChunkHandler = (audio: Uint8Array<ArrayBuffer>) => void;

export interface TranscribeInput {
  readonly audio: Blob;
  readonly language?: LanguageCode;
}

export interface TranscribeStreamInput {
  readonly language?: LanguageCode;
  readonly onPartial?: (text: string) => void;
  readonly onFinal?: (text: string) => void;
  readonly onSpeechStart?: () => void;
  readonly onSpeechEnd?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly signal?: AbortSignal;
}

export interface DiscussHistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface DiscussInput {
  readonly question: string;
  readonly documentText: string;
  readonly language?: LanguageCode;
  readonly history?: readonly DiscussHistoryMessage[];
  readonly spoken?: boolean;
  readonly onTextDelta?: (delta: string) => void;
}

export interface TextResult {
  readonly text: string;
  readonly provider: string;
}

export interface TranscribeStreamSession {
  /** Resolves once the realtime WebSocket is ready to accept audio. */
  readonly ready: Promise<void>;
  pushAudio(audio: Uint8Array<ArrayBuffer>): void;
  /** Flush one utterance and wait for its final transcript; the socket remains open. */
  finish(): Promise<TextResult>;
  /** Explicitly close the persistent realtime socket. */
  close(): void;
}

export interface SpeakResult {
  readonly audio: Blob;
  readonly provider: string;
}

export interface DiscussResult {
  readonly answer: string;
  readonly grounded: boolean;
  readonly provider: string;
}

/** All AI I/O passes through this seam; concrete providers arrive in later tasks. */
export interface LanguageProvider {
  readonly name: string;
  translate(input: TranslateInput): Promise<TextResult>;
  explain(input: ExplainInput): Promise<TextResult>;
  speak(input: SpeakInput): Promise<SpeakResult>;
  transcribe(input: TranscribeInput): Promise<TextResult>;
  discuss(input: DiscussInput): Promise<DiscussResult>;
}
