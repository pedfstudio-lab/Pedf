import type { TextEdit } from '@/lib/export/types';
import type { TextBlock } from '@/lib/pdf/textContent';
import { startsWithBulletMarker } from '@/lib/pdf/textUnits';

const SOFT_HYPHENATED_LINE_END = /[-\u2011]$/;
const LOWERCASE_LINE_START = /^\p{Ll}/u;

function normalizedLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function flowingLines(lines: readonly string[]): string {
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

/** Turn PDF display lines into the flowing value used by a first-time paragraph edit. */
export function paragraphSeedText(block: TextBlock): string {
  if (block.lines.length <= 1) return block.text;

  const lines = block.lines.map((line) => normalizedLine(line.text));
  return flowingLines(lines);
}

/** Keep marker-list items separate while allowing each item to flow within its own line. */
export function listSeedText(block: TextBlock): string {
  if (block.lines.length <= 1) return block.text;
  if (!block.lines.some((line) => startsWithBulletMarker(line.text))) {
    return paragraphSeedText(block);
  }

  const items: string[][] = [];
  for (const line of block.lines) {
    const normalized = normalizedLine(line.text);
    if (startsWithBulletMarker(line.text) || items.length === 0) {
      items.push([normalized]);
    } else {
      items.at(-1)?.push(normalized);
    }
  }
  return items.map(flowingLines).join('\n');
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
