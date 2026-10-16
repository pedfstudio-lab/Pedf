import type { TextStyle } from '@/lib/export/types';

export interface FontFragment { readonly start: number; readonly text: string; readonly style: TextStyle }
export interface WordRange { readonly start: number; readonly end: number }
/** A single routing decision across rich-style and source-piece boundaries. */
export function fallbackWordRanges(text: string, fragments: readonly FontFragment[], reusable: (text: string, style: TextStyle) => boolean): WordRange[] {
  const result: WordRange[] = [];
  for (const word of text.matchAll(/\S+/gu)) {
    const start = word.index, end = start + word[0].length;
    const members = fragments.filter(part => part.start < end && part.start + part.text.length > start);
    if (members.some(part => !reusable(part.text.slice(Math.max(0, start - part.start), Math.min(part.text.length, end - part.start)), part.style))) result.push({ start, end });
  }
  return result;
}
export function overlapsFallback(start: number, length: number, ranges: readonly WordRange[]): boolean {
  return ranges.some(range => range.start < start + length && range.end > start);
}
export function locateFragments(text: string, parts: readonly { text: string; style: TextStyle }[]): FontFragment[] {
  let cursor = 0;
  return parts.map(part => {
    const found = text.indexOf(part.text, cursor), start = found >= cursor ? found : cursor;
    cursor = start + part.text.length;
    return { ...part, start };
  });
}
