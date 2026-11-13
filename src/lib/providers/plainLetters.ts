/**
 * Look-alike maths letters (𝐸𝑛𝑔𝑖𝑛𝑒𝑒𝑟𝑠, 𝐀, 𝒜, 𝔄, 𝔸, ℎ, ℝ…) and the plain letters they stand for.
 *
 * Maths and exam-prep PDFs write formulas with them. Sarvam's content filter treats a page full of
 * them as an attempt to sneak text past it and refuses the whole request (an NMAT Logical Reasoning
 * PDF's page 21, with 62 of them, did exactly that). Only these characters change: the words, maths
 * symbols (⊂ ∩ ∅ →) and Indian scripts stay exactly as they are.
 *
 * Applied only to the copy of the text sent to Sarvam. The PDF and the screen are untouched.
 */
const LOOK_ALIKE_LETTER = /[\u{1D400}-\u{1D7FF}ℂℊ-ℓℕℙ-ℝℤℨℬℭℯ-ℱℳℴ]/u;
const LOOK_ALIKE_LETTERS = new RegExp(LOOK_ALIKE_LETTER.source, 'gu');

export function toPlainLetters(text: string): string {
  return LOOK_ALIKE_LETTER.test(text) ? text.replace(LOOK_ALIKE_LETTERS, (letter) => letter.normalize('NFKC')) : text;
}
