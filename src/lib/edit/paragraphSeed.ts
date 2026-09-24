import type { TextEdit } from '@/lib/export/types';
import type { TextBlock } from '@/lib/pdf/textContent';

const SOFT_HYPHENATED_LINE_END = /[-\u2011]$/;
const LOWERCASE_LINE_START = /^\p{Ll}/u;

function normalizedLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** Turn PDF display lines into the flowing value used by a first-time paragraph edit. */
export function paragraphSeedText(block: TextBlock): string {
  if (block.lines.length <= 1) return block.text;

  const lines = block.lines.map((line) => normalizedLine(line.text));
  let seed = lines[0] ?? '';
  for (const line of lines.slice(1)) {
    if (SOFT_HYPHENATED_LINE_END.test(seed) && LOWERCASE_LINE_START.test(line)) {
      seed = `${seed.slice(0, -1)}${line}`;
    } else {
      seed = `${seed} ${line}`;
    }
  }
  return seed.replace(/\s+/g, ' ').trim();
}

/** Preserve the line breaks currently displayed when measuring an editor's width. */
export function editorWidthMeasurementText(
  block: TextBlock,
  existing?: readonly TextEdit[],
): string {
  return existing?.length
    ? existing.map((edit) => edit.text).join('\n')
    : block.text;
}

/** Measure displayed lines independently so hard PDF line breaks do not become one giant width. */
export function widestLineWidth(
  text: string,
  measure: (line: string) => number,
): number {
  return Math.max(
    0,
    ...text.replace(/\r\n?/g, '\n').split('\n').map(measure),
  );
}
