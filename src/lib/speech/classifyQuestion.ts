export type QuestionKind = 'conversational' | 'document';

const MAX_CONVERSATIONAL_WORDS = 14;
const LEADING_CONVERSATIONAL_FILLERS = /^(?:(?:hi|hello|hey|so|well|um|uh|okay|yeah|hmm)\b[\s,;:!.-]+)+/u;

const LOCAL_GREETING_PHRASES = new Set([
  'नमस्ते',
  'नमस्कार',
  'धन्यवाद',
  'अलविदा',
  'வணக்கம்',
  'நன்றி',
  'নমস্কার',
  'ধন্যবাদ',
  'నమస్కారం',
  'ధన్యవాదాలు',
  'આભાર',
  'ನಮಸ್ಕಾರ',
  'ಧನ್ಯವಾದ',
  'നമസ്കാരം',
  'നന്ദി',
  'ਸਤ ਸ੍ਰੀ ਅਕਾਲ',
  'ਧੰਨਵਾਦ',
]);

function normalizeQuestion(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-IN')
    .replace(/[’‘]/gu, "'")
    .replace(/[?!.,;:…।॥]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Cheap local routing for voice fillers; this never calls a provider or model. */
export function classifyQuestion(text: string): QuestionKind {
  const normalized = normalizeQuestion(text);
  if (normalized === '') return 'document';
  if (LOCAL_GREETING_PHRASES.has(normalized)) return 'conversational';

  const question = normalized.replace(LEADING_CONVERSATIONAL_FILLERS, '').trim();
  if (question === '' || /^(?:there|friend|buddy)$/u.test(question)) {
    return 'conversational';
  }

  const words = question.split(' ');
  if (words.length > MAX_CONVERSATIONAL_WORDS) return 'document';

  const greetingOrSignoff = /\b(?:(?:hi|hello|hey)(?: there)?|good (?:morning|afternoon|evening|night)|namaste|namaskar|thanks?(?: you)?(?: a lot| so much)?|thank you(?: so much)?|bye|goodbye|see you(?: later)?)\b/u;
  const smallTalkOrOpinion = /\b(?:how (?:are )?you(?: doing)?|how(?:'s| is) it going|how are things|what(?:'s| is) up|who are you|are you (?:an? )?(?:ai|bot|assistant|real person)|what do you think|what(?:'s| is) your opinion|do you like|how do you feel|which do you prefer)\b/u;

  return greetingOrSignoff.test(question) || smallTalkOrOpinion.test(question)
    ? 'conversational'
    : 'document';
}
