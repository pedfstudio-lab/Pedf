/** Devanagari U+0900–097F and Tamil U+0B80–0BFF. */
export const INDIC = /[\u0900-\u097F\u0B80-\u0BFF]/u;

export function isIndicRun(text: string): boolean {
  return INDIC.test(text);
}
