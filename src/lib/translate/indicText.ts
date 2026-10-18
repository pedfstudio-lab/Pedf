/** Scripts supported by Translate, plus Odia. Devanagari is shared by Hindi/Marathi. */
const SCRIPTS = [
  ['Hindi', /\p{Script=Devanagari}/u], ['Tamil', /\p{Script=Tamil}/u],
  ['Bengali', /\p{Script=Bengali}/u], ['Telugu', /\p{Script=Telugu}/u],
  ['Gujarati', /\p{Script=Gujarati}/u], ['Kannada', /\p{Script=Kannada}/u],
  ['Malayalam', /\p{Script=Malayalam}/u], ['Punjabi', /\p{Script=Gurmukhi}/u],
  ['Odia', /\p{Script=Oriya}/u],
] as const;

export function indicLanguage(text: string): string | undefined {
  return SCRIPTS.find(([, pattern]) => pattern.test(text))?.[0];
}

export function indicEditMessage(text: string): string | undefined {
  const language = indicLanguage(text);
  return language ? `Editing supports English text. Use Translate to read this page in ${language}.` : undefined;
}

export function withoutIndicText(text: string): string {
  return [...text].filter(character => !indicLanguage(character)).join('');
}
