import { defaultProviders } from '@/lib/providers';
import type { SpeakInput, SpeakResult } from '@/lib/providers/types';
import type { SupportedLanguageCode } from '@/state/prefsStore';

/** A short human beat after the user stops speaking; tune within roughly 500–1000 ms. */
export const ACKNOWLEDGMENT_DELAY_MS = 600;
/** Grace period after the starter before a rare thinking filler is needed. */
export const BRIDGING_INITIAL_DELAY_MS = 1500;
/** Natural silence between the limited thinking fillers. */
export const BRIDGING_GAP_MS = 1500;
/** Avoid filler spam even when an answer is unusually slow. */
export const MAX_BRIDGING_FILLERS = 2;

export const ACKNOWLEDGMENT_PHRASES: Readonly<Record<SupportedLanguageCode, readonly string[]>> = {
  'en-IN': ['Sure, let me check that.', 'One moment.', 'Give me a second.'],
  'hi-IN': ['ज़रूर, मुझे देखने दीजिए।', 'एक क्षण।', 'बस एक सेकंड।'],
  'ta-IN': ['நிச்சயமாக, நான் பார்த்துச் சொல்கிறேன்.', 'ஒரு நிமிடம்.', 'ஒரு வினாடி.'],
  'bn-IN': ['অবশ্যই, আমাকে দেখে বলতে দিন।', 'একটু অপেক্ষা করুন।', 'এক সেকেন্ড।'],
  'te-IN': ['తప్పకుండా, చూసి చెబుతాను.', 'ఒక్క క్షణం.', 'ఒక్క సెకను.'],
  'mr-IN': ['नक्की, मला तपासू द्या.', 'एक क्षण.', 'फक्त एक सेकंद.'],
  'gu-IN': ['ચોક્કસ, મને તપાસવા દો.', 'એક ક્ષણ.', 'બસ એક સેકન્ડ.'],
  'kn-IN': ['ಖಂಡಿತ, ನಾನು ಪರಿಶೀಲಿಸುತ್ತೇನೆ.', 'ಒಂದು ಕ್ಷಣ.', 'ಒಂದು ಸೆಕೆಂಡ್.'],
  'ml-IN': ['തീർച്ചയായും, ഞാൻ പരിശോധിക്കാം.', 'ഒരു നിമിഷം.', 'ഒരു സെക്കൻഡ്.'],
  'pa-IN': ['ਜ਼ਰੂਰ, ਮੈਨੂੰ ਵੇਖਣ ਦਿਓ।', 'ਇੱਕ ਪਲ।', 'ਬਸ ਇੱਕ ਸਕਿੰਟ।'],
};

export const BRIDGING_PHRASES: Readonly<Record<SupportedLanguageCode, readonly string[]>> = {
  'en-IN': ['Just a moment.', 'Still looking.', 'Almost there.'],
  'hi-IN': ['बस एक क्षण।', 'अभी देख रही हूँ।', 'लगभग हो गया।'],
  'ta-IN': ['ஒரு நிமிடம்.', 'இன்னும் பார்த்துக்கொண்டிருக்கிறேன்.', 'கிட்டத்தட்ட முடிந்தது.'],
  'bn-IN': ['একটু অপেক্ষা করুন।', 'এখনও দেখছি।', 'প্রায় হয়ে গেছে।'],
  'te-IN': ['ఒక్క క్షణం.', 'ఇంకా చూస్తున్నాను.', 'దాదాపు పూర్తయింది.'],
  'mr-IN': ['एक क्षण.', 'अजून तपासत आहे.', 'जवळजवळ झाले.'],
  'gu-IN': ['એક ક્ષણ.', 'હજુ તપાસી રહી છું.', 'લગભગ થઈ ગયું.'],
  'kn-IN': ['ಒಂದು ಕ್ಷಣ.', 'ಇನ್ನೂ ಪರಿಶೀಲಿಸುತ್ತಿದ್ದೇನೆ.', 'ಬಹುತೇಕ ಮುಗಿಯಿತು.'],
  'ml-IN': ['ഒരു നിമിഷം.', 'ഇപ്പോഴും പരിശോധിക്കുകയാണ്.', 'ഏകദേശം കഴിഞ്ഞു.'],
  'pa-IN': ['ਇੱਕ ਪਲ।', 'ਹਾਲੇ ਵੀ ਵੇਖ ਰਹੀ ਹਾਂ।', 'ਲਗਭਗ ਹੋ ਗਿਆ।'],
};

type Speak = (input: SpeakInput) => Promise<SpeakResult>;

export function waitForAcknowledgmentDelay(
  delayMs = ACKNOWLEDGMENT_DELAY_MS,
): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function waitForBridgingGap(delayMs = BRIDGING_GAP_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function waitForBridgingInitialDelay(
  delayMs = BRIDGING_INITIAL_DELAY_MS,
): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

interface CachedAcknowledgment {
  readonly audio: Blob;
  readonly phrase: string;
}

interface LanguageAcknowledgments {
  readonly acknowledgments: readonly CachedAcknowledgment[];
  readonly bridges: readonly CachedAcknowledgment[];
}

export interface AcknowledgmentManager {
  preload(language: string): Promise<void>;
  take(language: string): Blob | null;
  takePhrase(language: string): string;
  takeBridge(language: string): Blob | null;
}

function supportedLanguage(language: string): SupportedLanguageCode {
  return Object.prototype.hasOwnProperty.call(ACKNOWLEDGMENT_PHRASES, language)
    ? language as SupportedLanguageCode
    : 'en-IN';
}

function boundedRandom(random: () => number): number {
  return Math.max(0, Math.min(0.999999, random()));
}

/** A testable in-memory cache; the app uses the singleton exported below. */
export function createAcknowledgmentManager(
  speak: Speak,
  random: () => number = Math.random,
): AcknowledgmentManager {
  const cache = new Map<SupportedLanguageCode, LanguageAcknowledgments>();
  const pending = new Map<SupportedLanguageCode, Promise<void>>();
  const audioIndexes = new Map<SupportedLanguageCode, number>();
  const bridgeIndexes = new Map<SupportedLanguageCode, number>();
  const phraseIndexes = new Map<SupportedLanguageCode, number>();

  const nextIndex = (
    language: SupportedLanguageCode,
    length: number,
    indexes: Map<SupportedLanguageCode, number>,
  ): number => {
    const previous = indexes.get(language);
    const value = boundedRandom(random);
    const next = previous === undefined
      ? Math.floor(value * length)
      : length === 1
        ? 0
        : (previous + 1 + Math.floor(value * (length - 1))) % length;
    indexes.set(language, next);
    return next;
  };

  return {
    async preload(language) {
      const resolved = supportedLanguage(language);
      if (cache.has(resolved)) return;
      const activeLoad = pending.get(resolved);
      if (activeLoad) return activeLoad;

      const load = (async () => {
        const loadPhrases = async (
          phrases: readonly string[],
        ): Promise<readonly CachedAcknowledgment[]> => {
          const results = await Promise.allSettled(
            phrases.map(async (phrase): Promise<CachedAcknowledgment> => {
              const result = await speak({ text: phrase, language: resolved });
              return { audio: result.audio, phrase };
            }),
          );
          return results.flatMap(
            (result) => result.status === 'fulfilled' ? [result.value] : [],
          );
        };
        const [acknowledgments, bridges] = await Promise.all([
          loadPhrases(ACKNOWLEDGMENT_PHRASES[resolved]),
          loadPhrases(BRIDGING_PHRASES[resolved]),
        ]);
        cache.set(resolved, { acknowledgments, bridges });
      })();
      pending.set(resolved, load);
      try {
        await load;
      } finally {
        pending.delete(resolved);
      }
    },

    take(language) {
      const resolved = supportedLanguage(language);
      const clips = cache.get(resolved)?.acknowledgments;
      if (!clips || clips.length === 0) return null;
      return clips[nextIndex(resolved, clips.length, audioIndexes)]?.audio ?? null;
    },

    takePhrase(language) {
      const resolved = supportedLanguage(language);
      const phrases = ACKNOWLEDGMENT_PHRASES[resolved];
      return phrases[nextIndex(resolved, phrases.length, phraseIndexes)]
        ?? phrases[0]
        ?? 'One moment.';
    },

    takeBridge(language) {
      const resolved = supportedLanguage(language);
      const clips = cache.get(resolved)?.bridges;
      if (!clips || clips.length === 0) return null;
      return clips[nextIndex(resolved, clips.length, bridgeIndexes)]?.audio ?? null;
    },
  };
}

const acknowledgments = createAcknowledgmentManager(
  (input) => defaultProviders().speak(input),
);

export const preloadAcknowledgments = (language: string): Promise<void> =>
  acknowledgments.preload(language);

export const takeAcknowledgment = (language: string): Blob | null =>
  acknowledgments.take(language);

export const takeAcknowledgmentPhrase = (language: string): string =>
  acknowledgments.takePhrase(language);

export const takeBridgingAcknowledgment = (language: string): Blob | null =>
  acknowledgments.takeBridge(language);
