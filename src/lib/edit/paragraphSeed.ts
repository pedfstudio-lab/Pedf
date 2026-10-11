import type { TextEdit, TextParagraphLayout } from '@/lib/export/types';
import type { TextBlock } from '@/lib/pdf/textContent';
import { firstWordWidthPt, intrinsicBold, startsWithBulletMarker } from '@/lib/pdf/textUnits';
import { normalizeSymbolBulletPrefix } from '@/lib/pdf/symbolBullets';

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

/** Keep intentional line ends; only a word that did not fit proves a soft wrap. */
export function sourceParagraphLineHeight(block: TextBlock): number {
  const bins = new Map<number, number[]>();
  block.lines.slice(1).forEach((line, index) => {
    const gap = block.lines[index]!.baselineY - line.baselineY;
    if (gap <= 0.5) return;
    const key = Math.round(gap * 2), values = bins.get(key) ?? []; values.push(gap); bins.set(key, values);
  });
  const values = [...bins].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0]?.[1];
  // A page can use the same face/size with different leading in its lists and
  // prose. Repeated spacing inside this box is stronger evidence for its editor
  // than the page-wide pitch (which remains the grouping threshold).
  if (values && values.length >= 2) return values.reduce((a, b) => a + b, 0) / values.length;
  if (block.paragraphLineHeightPt) return block.paragraphLineHeightPt;
  return values?.length ? values.reduce((a, b) => a + b, 0) / values.length : block.lineHeightPt;
}

export function sourceParagraphs(block: TextBlock): { text: string; layouts: readonly TextParagraphLayout[]; lines: readonly (readonly TextBlock['lines'][number][])[] } {
  if (block.lines.length <= 1 || (block.align ?? 'left') !== 'left') return {
    text: block.text, layouts: [{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }], lines: [block.lines],
  };
  const lines = block.lines.map((line) => normalizedLine(line.text));
  const right = Math.max(block.rect.x + block.rect.w,
    block.alignLeftPt !== undefined && block.alignWidthPt !== undefined ? block.alignLeftPt + block.alignWidthPt : 0);
  let seed = lines[0] ?? '';
  const groups: TextBlock['lines'][number][][] = [[block.lines[0]!]];
  const normal = sourceParagraphLineHeight(block);
  for (let index = 1; index < lines.length; index += 1) {
    const upper = block.lines[index - 1]!, lower = block.lines[index]!;
    const wordWidth = firstWordWidthPt(lower);
    // A short all-capitals bold label is not a wrapped sentence. Its value can
    // be only slightly wider, making the widest-line edge alone misleading.
    const label = /^\p{Lu}[\p{Lu}\p{N}\s]*$/u.test(upper.text.trim())
      && upper.runs.length > 0 && upper.runs.every(run => intrinsicBold(run.style))
      && lower.runs.some(run => !intrinsicBold(run.style));
    const soft = !label && upper.baselineY - lower.baselineY <= normal + 0.5
      && wordWidth !== undefined && wordWidth + (lower.runs[0]?.spaceWidthPt ?? 0)
      > right - (upper.rect.x + upper.rect.w) + 0.5;
    const text = lines[index]!;
    seed = soft && SOFT_HYPHENATED_LINE_END.test(seed) && LOWERCASE_LINE_START.test(text)
      ? seed.slice(0, -1) + text : seed + (soft ? ' ' : '\n') + text;
    if (soft) groups.at(-1)!.push(lower); else groups.push([lower]);
  }
  return { text: seed, lines: groups, layouts: groups.map((group, index) => {
    const previous = groups[index - 1]?.at(-1), first = group[0]!;
    const gap = previous ? previous.baselineY - first.baselineY - normal : 0;
    const rest = group.slice(1).map(line => line.rect.x - block.rect.x).sort((a, b) => a - b);
    return { gapBeforePt: gap > 0.5 ? gap : 0,
      firstIndentPt: Math.max(0, first.rect.x - block.rect.x),
      restIndentPt: Math.max(0, rest.length ? rest[Math.floor(rest.length / 2)]! : first.rect.x - block.rect.x) };
  }) };
}

export function paragraphSeedText(block: TextBlock): string {
  return sourceParagraphs(block).text;
}

/** Keep marker-list items separate while allowing each item to flow within its own line. */
export function listSeedText(block: TextBlock): string {
  if (block.lines.length <= 1) return normalizeSymbolBulletPrefix(block.text);
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
  return items.map(flowingLines).map(normalizeSymbolBulletPrefix).join('\n');
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
