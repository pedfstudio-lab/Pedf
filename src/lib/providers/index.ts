import { BrowserProvider } from './browser';
import { providerConfig } from './config';
import { ProviderChainError } from './errors';
import { describeProviderError, logProviderAttempt } from './log';
import type {
  ProviderCandidate,
  ProviderInputMap,
  ProviderMethod,
  ProviderResultMap,
} from './providerTypes';
import { SarvamProvider } from './sarvam';
import type {
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

function elapsed(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

async function callProviderChain<Method extends ProviderMethod>(
  providers: readonly ProviderCandidate[],
  method: Method,
  input: ProviderInputMap[Method],
): Promise<ProviderResultMap[Method]> {
  const errors: unknown[] = [];
  let supportedProviderCount = 0;

  for (const provider of providers) {
    if (provider.supports && !provider.supports(method)) continue;
    supportedProviderCount += 1;
    const startedAt = performance.now();
    try {
      const operation = provider[method] as (
        value: ProviderInputMap[Method],
      ) => Promise<ProviderResultMap[Method]>;
      const result = await operation.call(provider, input);
      logProviderAttempt({
        provider: provider.name,
        method,
        ok: true,
        ms: elapsed(startedAt),
      });
      return result;
    } catch (error) {
      errors.push(error);
      logProviderAttempt({
        provider: provider.name,
        method,
        ok: false,
        ms: elapsed(startedAt),
        error: describeProviderError(error),
      });
    }
  }

  throw new ProviderChainError(method, errors, supportedProviderCount);
}

/** Create the stable LanguageProvider facade used by every later AI feature. */
export function createProviderChain(
  providers: readonly ProviderCandidate[],
): LanguageProvider {
  return {
    name: 'Provider chain',
    translate: (input: TranslateInput): Promise<TextResult> =>
      callProviderChain(providers, 'translate', input),
    explain: (input: ExplainInput): Promise<TextResult> =>
      callProviderChain(providers, 'explain', input),
    speak: (input: SpeakInput): Promise<SpeakResult> =>
      callProviderChain(providers, 'speak', input),
    transcribe: (input: TranscribeInput): Promise<TextResult> =>
      callProviderChain(providers, 'transcribe', input),
    discuss: (input: DiscussInput): Promise<DiscussResult> =>
      callProviderChain(providers, 'discuss', input),
  };
}

/** Fixed default order: Sarvam first, then any explicitly supported browser fallbacks. */
export function defaultProviders(): LanguageProvider {
  return createProviderChain([
    new SarvamProvider(providerConfig),
    new BrowserProvider(),
  ]);
}

export { BrowserProvider } from './browser';
export { providerConfig } from './config';
export { NotImplementedError, NotSupportedError, ProviderChainError } from './errors';
export { clearProviderLog, getProviderLog } from './log';
export type { ProviderAttempt } from './log';
export type { ProviderCandidate, ProviderMethod, ProviderWithCapabilities } from './providerTypes';
export { SarvamProvider } from './sarvam';
