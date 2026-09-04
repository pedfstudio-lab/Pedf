import type {
  ChatMessage,
  DiscussInput,
  DiscussResult,
  ExplainInput,
  LanguageProvider,
  SpeakInput,
  SpeakResult,
  TextResult,
  TranscribeInput,
  TranslateInput,
} from './types';

export type ProviderMethod = keyof Pick<
  LanguageProvider,
  'complete' | 'translate' | 'explain' | 'speak' | 'transcribe' | 'discuss'
>;

export interface ProviderInputMap {
  readonly complete: readonly ChatMessage[];
  readonly translate: TranslateInput;
  readonly explain: ExplainInput;
  readonly speak: SpeakInput;
  readonly transcribe: TranscribeInput;
  readonly discuss: DiscussInput;
}

export interface ProviderResultMap {
  readonly complete: TextResult;
  readonly translate: TextResult;
  readonly explain: TextResult;
  readonly speak: SpeakResult;
  readonly transcribe: TextResult;
  readonly discuss: DiscussResult;
}

/** Capability metadata stays beside the stable LanguageProvider seam. */
export interface ProviderWithCapabilities extends LanguageProvider {
  supports(method: ProviderMethod): boolean;
}

/** Existing/optional providers without metadata remain compatible and are assumed to support every method. */
export type ProviderCandidate = LanguageProvider & {
  readonly supports?: (method: ProviderMethod) => boolean;
};
