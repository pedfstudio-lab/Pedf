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
/** Keep preload traffic below the provider's burst limits. */
export const ACKNOWLEDGMENT_PRELOAD_CONCURRENCY = 4;
/** Retry transient synthesis failures without letting preload loop forever. */
export const ACKNOWLEDGMENT_SYNTHESIS_RETRIES = 2;

export const ACKNOWLEDGMENT_PHRASES: Readonly<Record<SupportedLanguageCode, readonly string[]>> = {
  'en-IN': [
    'Sure, let me take a look.',
    'Yeah, let me check that for you.',
    'Okay, one sec while I look.',
    'Let me find that.',
    'Hmm, let me see.',
    'Sure thing, give me a moment.',
    'Got it, let me look through this.',
    'Okay, checking now.',
    'Let me pull that up.',
    'Alright, let me have a look.',
    'Sure, just a sec.',
    'Let me scan through it.',
  ],
  'hi-IN': [
    'ज़रूर, ज़रा देखती हूँ।',
    'हाँ, आपके लिए देखती हूँ।',
    'ठीक है, बस एक पल—देखती हूँ।',
    'मुझे यह ढूँढने दीजिए।',
    'हम्म, ज़रा देखती हूँ।',
    'ज़रूर, एक पल दीजिए।',
    'समझ गई, इसमें देखती हूँ।',
    'ठीक है, अभी जाँचती हूँ।',
    'अभी वह हिस्सा निकालती हूँ।',
    'अच्छा, ज़रा देखती हूँ।',
    'ज़रूर, बस एक सेकंड।',
    'इसे जल्दी से देखती हूँ।',
  ],
  'ta-IN': [
    'சரி, ஒரு முறை பார்த்துவிடுகிறேன்.',
    'ஆமாம், உங்களுக்காகப் பார்க்கிறேன்.',
    'சரி, பார்க்கிறேன்—ஒரு நொடி.',
    'அதைத் தேடிப் பார்க்கிறேன்.',
    'ஹூம், பார்க்கலாம்.',
    'கண்டிப்பாக, ஒரு நிமிடம்.',
    'புரிந்தது, இதைப் பார்த்துவிடுகிறேன்.',
    'சரி, இப்போது பார்க்கிறேன்.',
    'அந்தப் பகுதியை எடுத்துப் பார்க்கிறேன்.',
    'சரி, கொஞ்சம் பார்க்கிறேன்.',
    'கண்டிப்பாக, ஒரு நொடி.',
    'இதைச் சீக்கிரம் பார்த்துவிடுகிறேன்.',
  ],
  'bn-IN': [
    'অবশ্যই, একটু দেখে নিচ্ছি।',
    'হ্যাঁ, আপনার জন্য দেখে দিচ্ছি।',
    'ঠিক আছে, দেখছি—একটু সময় দিন।',
    'এটা খুঁজে দেখি।',
    'হুম, দেখি তো।',
    'অবশ্যই, একটু সময় দিন।',
    'বুঝেছি, নথিটা দেখে নিচ্ছি।',
    'ঠিক আছে, এখনই দেখছি।',
    'ওই অংশটা বের করছি।',
    'আচ্ছা, একটু দেখে নিই।',
    'অবশ্যই, শুধু এক সেকেন্ড।',
    'নথিটা দ্রুত দেখে নিচ্ছি।',
  ],
  'te-IN': [
    'తప్పకుండా, ఒకసారి చూస్తాను.',
    'అవును, మీ కోసం చూసి చెబుతాను.',
    'సరే, చూస్తున్నాను—ఒక్క క్షణం.',
    'అది ఎక్కడుందో చూస్తాను.',
    'హ్మ్, చూద్దాం.',
    'తప్పకుండా, కాసేపు ఇవ్వండి.',
    'అర్థమైంది, ఇందులో చూస్తాను.',
    'సరే, ఇప్పుడే చూస్తున్నాను.',
    'ఆ భాగాన్ని తీసి చూస్తాను.',
    'సరే, ఒకసారి చూద్దాం.',
    'తప్పకుండా, ఒక్క సెకను.',
    'దీన్ని త్వరగా చూసేస్తాను.',
  ],
  'mr-IN': [
    'नक्की, जरा पाहते.',
    'हो, तुमच्यासाठी तपासते.',
    'ठीक आहे, पाहतेय—एक क्षण.',
    'ते शोधून पाहते.',
    'हम्म, बघूया.',
    'नक्की, एक क्षण द्या.',
    'समजलं, यात पाहते.',
    'ठीक आहे, आत्ताच तपासते.',
    'तो भाग काढून पाहते.',
    'बरं, जरा बघते.',
    'नक्की, फक्त एक सेकंद.',
    'हे पटकन पाहून घेते.',
  ],
  'gu-IN': [
    'ચોક્કસ, જરા જોઈ લઉં.',
    'હા, તમારા માટે તપાસું છું.',
    'ઠીક છે, જોઉં છું—એક ક્ષણ.',
    'એ શોધી જોઉં.',
    'હમ્મ, જોવા દો.',
    'ચોક્કસ, એક પળ આપો.',
    'સમજાયું, આમાં જોઈ લઉં.',
    'ઠીક છે, હમણાં તપાસું છું.',
    'એ ભાગ કાઢીને જોઉં.',
    'સારું, જરા નજર કરું.',
    'ચોક્કસ, બસ એક સેકન્ડ.',
    'આને ઝડપથી જોઈ લઉં.',
  ],
  'kn-IN': [
    'ಖಂಡಿತ, ಒಮ್ಮೆ ನೋಡುತ್ತೇನೆ.',
    'ಹೌದು, ನಿಮಗಾಗಿ ಪರಿಶೀಲಿಸುತ್ತೇನೆ.',
    'ಸರಿ, ನೋಡುತ್ತಿದ್ದೇನೆ—ಒಂದು ಕ್ಷಣ.',
    'ಅದನ್ನು ಹುಡುಕಿ ನೋಡುತ್ತೇನೆ.',
    'ಹ್ಮ್, ನೋಡೋಣ.',
    'ಖಂಡಿತ, ಸ್ವಲ್ಪ ಸಮಯ ಕೊಡಿ.',
    'ಅರ್ಥವಾಯಿತು, ಇದರಲ್ಲಿ ನೋಡುತ್ತೇನೆ.',
    'ಸರಿ, ಈಗಲೇ ಪರಿಶೀಲಿಸುತ್ತೇನೆ.',
    'ಆ ಭಾಗವನ್ನು ತೆಗೆದು ನೋಡುತ್ತೇನೆ.',
    'ಸರಿ, ಒಮ್ಮೆ ನೋಡೋಣ.',
    'ಖಂಡಿತ, ಒಂದು ಸೆಕೆಂಡ್.',
    'ಇದನ್ನು ಬೇಗ ನೋಡುತ್ತೇನೆ.',
  ],
  'ml-IN': [
    'തീർച്ചയായും, ഒന്ന് നോക്കട്ടെ.',
    'അതെ, നിങ്ങൾക്കായി പരിശോധിക്കാം.',
    'ശരി, നോക്കുകയാണ്—ഒരു നിമിഷം.',
    'അത് കണ്ടെത്തി നോക്കാം.',
    'ഹും, നോക്കട്ടെ.',
    'തീർച്ചയായും, ഒരു നിമിഷം തരൂ.',
    'മനസ്സിലായി, ഇതിൽ നോക്കാം.',
    'ശരി, ഇപ്പോൾ പരിശോധിക്കാം.',
    'ആ ഭാഗം എടുത്തു നോക്കാം.',
    'ശരി, ഒന്ന് നോക്കട്ടെ.',
    'തീർച്ചയായും, ഒരു സെക്കൻഡ്.',
    'ഇത് വേഗം നോക്കാം.',
  ],
  'pa-IN': [
    'ਜ਼ਰੂਰ, ਜ਼ਰਾ ਵੇਖਦੀ ਹਾਂ।',
    'ਹਾਂ, ਤੁਹਾਡੇ ਲਈ ਚੈੱਕ ਕਰਦੀ ਹਾਂ।',
    'ਠੀਕ ਹੈ, ਵੇਖ ਰਹੀ ਹਾਂ—ਇੱਕ ਪਲ।',
    'ਇਹ ਲੱਭ ਕੇ ਵੇਖਦੀ ਹਾਂ।',
    'ਹੂੰਮ, ਵੇਖਦੀ ਹਾਂ।',
    'ਜ਼ਰੂਰ, ਇੱਕ ਪਲ ਦਿਓ।',
    'ਸਮਝ ਗਈ, ਇਸ ਵਿੱਚ ਵੇਖਦੀ ਹਾਂ।',
    'ਠੀਕ ਹੈ, ਹੁਣੇ ਚੈੱਕ ਕਰਦੀ ਹਾਂ।',
    'ਉਹ ਹਿੱਸਾ ਕੱਢ ਕੇ ਵੇਖਦੀ ਹਾਂ।',
    'ਚੰਗਾ, ਜ਼ਰਾ ਵੇਖਦੀ ਹਾਂ।',
    'ਜ਼ਰੂਰ, ਬਸ ਇੱਕ ਸਕਿੰਟ।',
    'ਇਸ ਨੂੰ ਛੇਤੀ ਵੇਖਦੀ ਹਾਂ।',
  ],
};

export const BRIDGING_PHRASES: Readonly<Record<SupportedLanguageCode, readonly string[]>> = {
  'en-IN': [
    'Still looking through it.',
    'Almost there.',
    'Bear with me a sec.',
    'Just going through it.',
    'Nearly got it.',
    'One more moment.',
    'Still scanning.',
    'Hang on, almost there.',
  ],
  'hi-IN': [
    'अभी इसमें देख रही हूँ।',
    'बस लगभग हो गया।',
    'एक सेकंड और दीजिए।',
    'बस इसे पढ़ रही हूँ।',
    'लगभग मिल गया।',
    'बस एक पल और।',
    'अभी भी देख रही हूँ।',
    'रुकिए, बस हो गया।',
  ],
  'ta-IN': [
    'இன்னும் இதைப் பார்த்துக்கொண்டிருக்கிறேன்.',
    'கிட்டத்தட்ட முடிந்தது.',
    'இன்னும் ஒரு நொடி பொறுங்கள்.',
    'இதைப் படித்துக்கொண்டிருக்கிறேன்.',
    'கிட்டத்தட்ட கிடைத்துவிட்டது.',
    'இன்னும் ஒரு நிமிடம்.',
    'தொடர்ந்து தேடிக்கொண்டிருக்கிறேன்.',
    'ஒரு நொடி, முடிந்துவிடும்.',
  ],
  'bn-IN': [
    'এখনও নথিটা দেখছি।',
    'প্রায় হয়ে গেছে।',
    'আর এক সেকেন্ড সময় দিন।',
    'নথিটা পড়ে দেখছি।',
    'প্রায় পেয়ে গেছি।',
    'আর একটু সময়।',
    'এখনও খুঁজে দেখছি।',
    'একটু থাকুন, প্রায় হয়ে গেছে।',
  ],
  'te-IN': [
    'ఇంకా ఇందులో చూస్తున్నాను.',
    'దాదాపు పూర్తయింది.',
    'ఇంకో సెకను ఆగండి.',
    'దీన్ని చదివి చూస్తున్నాను.',
    'దాదాపు దొరికింది.',
    'ఇంకొక్క క్షణం.',
    'ఇంకా వెతుకుతున్నాను.',
    'ఆగండి, దాదాపు అయిపోయింది.',
  ],
  'mr-IN': [
    'अजून यात पाहतेय.',
    'जवळजवळ झालं.',
    'आणखी एक सेकंद द्या.',
    'हे वाचून पाहतेय.',
    'जवळजवळ सापडलं.',
    'फक्त एक क्षण अजून.',
    'अजून शोधतेय.',
    'थांबा, जवळजवळ झालं.',
  ],
  'gu-IN': [
    'હજુ આમાં જોઈ રહી છું.',
    'લગભગ થઈ ગયું.',
    'હજી એક સેકન્ડ આપો.',
    'આને વાંચીને જોઈ રહી છું.',
    'લગભગ મળી ગયું.',
    'બસ એક પળ વધુ.',
    'હજુ શોધી રહી છું.',
    'જરા થોભો, લગભગ થઈ ગયું.',
  ],
  'kn-IN': [
    'ಇನ್ನೂ ಇದರಲ್ಲಿ ನೋಡುತ್ತಿದ್ದೇನೆ.',
    'ಬಹುತೇಕ ಮುಗಿಯಿತು.',
    'ಇನ್ನೊಂದು ಸೆಕೆಂಡ್ ಕೊಡಿ.',
    'ಇದನ್ನು ಓದಿ ನೋಡುತ್ತಿದ್ದೇನೆ.',
    'ಬಹುತೇಕ ಸಿಕ್ಕಿತು.',
    'ಇನ್ನೊಂದು ಕ್ಷಣ ಮಾತ್ರ.',
    'ಇನ್ನೂ ಹುಡುಕುತ್ತಿದ್ದೇನೆ.',
    'ಸ್ವಲ್ಪ ತಾಳಿ, ಬಹುತೇಕ ಆಯಿತು.',
  ],
  'ml-IN': [
    'ഇപ്പോഴും ഇതിൽ നോക്കുകയാണ്.',
    'ഏതാണ്ട് കഴിഞ്ഞു.',
    'ഒരു സെക്കൻഡ് കൂടി തരൂ.',
    'ഇത് വായിച്ചു നോക്കുകയാണ്.',
    'ഏതാണ്ട് കിട്ടി.',
    'ഒരു നിമിഷം കൂടി.',
    'ഇപ്പോഴും തിരയുകയാണ്.',
    'ഒന്ന് കാത്തിരിക്കൂ, ഏതാണ്ട് കഴിഞ്ഞു.',
  ],
  'pa-IN': [
    'ਹਾਲੇ ਇਸ ਵਿੱਚ ਵੇਖ ਰਹੀ ਹਾਂ।',
    'ਲਗਭਗ ਹੋ ਗਿਆ।',
    'ਇੱਕ ਸਕਿੰਟ ਹੋਰ ਦਿਓ।',
    'ਇਸ ਨੂੰ ਪੜ੍ਹ ਕੇ ਵੇਖ ਰਹੀ ਹਾਂ।',
    'ਲਗਭਗ ਮਿਲ ਗਿਆ।',
    'ਬਸ ਇੱਕ ਪਲ ਹੋਰ।',
    'ਹਾਲੇ ਵੀ ਲੱਭ ਰਹੀ ਹਾਂ।',
    'ਜ਼ਰਾ ਰੁਕੋ, ਲਗਭਗ ਹੋ ਗਿਆ।',
  ],
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

export interface AcknowledgmentManager {
  preload(language: string): Promise<void>;
  preloadBridges(language: string): Promise<void>;
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
  const acknowledgmentCache = new Map<SupportedLanguageCode, readonly CachedAcknowledgment[]>();
  const bridgeCache = new Map<SupportedLanguageCode, readonly CachedAcknowledgment[]>();
  const acknowledgmentPending = new Map<SupportedLanguageCode, Promise<void>>();
  const bridgePending = new Map<SupportedLanguageCode, Promise<void>>();
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

  const loadPool = async (
    resolved: SupportedLanguageCode,
    phrases: readonly string[],
    cache: Map<SupportedLanguageCode, readonly CachedAcknowledgment[]>,
    pending: Map<SupportedLanguageCode, Promise<void>>,
  ): Promise<void> => {
    if (cache.has(resolved)) return;
    const activeLoad = pending.get(resolved);
    if (activeLoad) return activeLoad;

    const load = (async () => {
      const clips: Array<CachedAcknowledgment | undefined> = Array.from({
        length: phrases.length,
      });
      let nextPhraseIndex = 0;

      const synthesize = async (
        phrase: string,
      ): Promise<CachedAcknowledgment | undefined> => {
        for (let attempt = 0; attempt <= ACKNOWLEDGMENT_SYNTHESIS_RETRIES; attempt += 1) {
          try {
            const result = await speak({ text: phrase, language: resolved });
            return { audio: result.audio, phrase };
          } catch {
            if (attempt === ACKNOWLEDGMENT_SYNTHESIS_RETRIES) return undefined;
          }
        }
        return undefined;
      };

      const worker = async (): Promise<void> => {
        while (nextPhraseIndex < phrases.length) {
          const index = nextPhraseIndex;
          nextPhraseIndex += 1;
          const phrase = phrases[index];
          if (phrase !== undefined) clips[index] = await synthesize(phrase);
        }
      };

      const workerCount = Math.min(ACKNOWLEDGMENT_PRELOAD_CONCURRENCY, phrases.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      cache.set(
        resolved,
        clips.filter((clip): clip is CachedAcknowledgment => clip !== undefined),
      );
    })();
    pending.set(resolved, load);
    try {
      await load;
    } finally {
      pending.delete(resolved);
    }
  };

  return {
    preload(language) {
      const resolved = supportedLanguage(language);
      return loadPool(
        resolved,
        ACKNOWLEDGMENT_PHRASES[resolved],
        acknowledgmentCache,
        acknowledgmentPending,
      );
    },

    preloadBridges(language) {
      const resolved = supportedLanguage(language);
      return loadPool(
        resolved,
        BRIDGING_PHRASES[resolved],
        bridgeCache,
        bridgePending,
      );
    },

    take(language) {
      const resolved = supportedLanguage(language);
      const clips = acknowledgmentCache.get(resolved);
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
      const clips = bridgeCache.get(resolved);
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

export const preloadBridgingAcknowledgments = (language: string): Promise<void> =>
  acknowledgments.preloadBridges(language);

export const takeAcknowledgment = (language: string): Blob | null =>
  acknowledgments.take(language);

export const takeAcknowledgmentPhrase = (language: string): string =>
  acknowledgments.takePhrase(language);

export const takeBridgingAcknowledgment = (language: string): Blob | null =>
  acknowledgments.takeBridge(language);
