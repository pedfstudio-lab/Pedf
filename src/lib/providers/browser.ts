import { NotImplementedError, NotSupportedError } from './errors';
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

const BROWSER_METHODS = new Set<ProviderMethod>(['speak', 'transcribe']);

/** Browser speech shell; Task 23 fills the speechSynthesis and Web Speech bodies. */
export class BrowserProvider implements ProviderWithCapabilities {
  readonly name = 'Browser';

  supports(method: ProviderMethod): boolean {
    return BROWSER_METHODS.has(method);
  }

  async translate(input: TranslateInput): Promise<TextResult> {
    void input;
    throw new NotSupportedError(this.name, 'translate');
  }

  async explain(input: ExplainInput): Promise<TextResult> {
    void input;
    throw new NotSupportedError(this.name, 'explain');
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
    throw new NotSupportedError(this.name, 'discuss');
  }
}
