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

export interface TranscribeInput {
  readonly audio: Blob;
  readonly language?: LanguageCode;
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
}

export interface TextResult {
  readonly text: string;
  readonly provider: string;
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
