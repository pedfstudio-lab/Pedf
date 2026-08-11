import type { ProviderConfig } from './config';
import { providerConfig } from './config';
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

/** Sarvam API shell; concrete Mayura/Bulbul/Saarika/Sarvam-M calls arrive in later tasks. */
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
    void input;
    throw new NotImplementedError(this.name, 'discuss');
  }
}
