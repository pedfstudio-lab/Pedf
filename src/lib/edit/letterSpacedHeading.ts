import type { TextBlock, TextLine } from '@/lib/pdf/textContent';

/** A piece written as single characters with spaces between them, e.g. `N E W`. */
const SPACED_PIECE = /^(?:\S\s+){2,}\S$/u;

const visible = (text: string) => text.replace(/\s+/gu, '').length;

/**
 * A letter-spaced heading line: most of its characters sit in `N E W`-style pieces.
 * One such piece alone proves nothing — a PDF that cuts its text into small pieces
 * can produce `h a b` from "with a bunch" in the middle of ordinary prose.
 */
export function isLetterSpacedLine(line: TextLine): boolean {
  const total = visible(line.text);
  const spaced = line.runs.filter(run => SPACED_PIECE.test(run.text.trim())).reduce((sum, run) => sum + visible(run.text), 0);
  return total > 0 && spaced * 2 > total;
}

export function hasLetterSpacedHeading(block: TextBlock): boolean {
  return block.lines.some(isLetterSpacedLine);
}
