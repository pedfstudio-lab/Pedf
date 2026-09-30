import type { PdfRect, TextAlignment, TextStyle } from '@/lib/export/types';
import type { RuleLine } from './ruleLines';
import type { TextLine, TextRun } from './textContent';

const TEXT_BULLET = /^\s*[\uF0B7\uF0A7\uF0A8\uF0D8\uF06C\uF075\uF0FC\uF0FD\u2022\u25CF\u25AA\u25E6\u2023\u2043\u00B7\u2219]/u;

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? (ordered[middle] ?? 0)
    : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

function isStandaloneNumber(text: string): boolean {
  return /^[\d.,/-]{1,6}$/.test(text.trim());
}

/** Recognize compact numeric values commonly printed in table cells. */
export function isTableNumber(text: string): boolean {
  const value = text.trim();
  if (isStandaloneNumber(value)) return true;
  if (value.length === 0 || value.length > 20) return false;
  const currency = String.raw`(?:₹|\$|€|£|Rs\.?)?\s*`;
  const number = String.raw`\d[\d,]*(?:\.\d+)?%?`;
  return new RegExp(`^(?:\\(${currency}${number}\\)|[-−+]?${currency}${number})$`).test(value);
}

function verticalRuleSeparates(
  left: TextRun,
  right: TextRun,
  ruleLines: readonly RuleLine[],
): boolean {
  const leftEdge = left.rect.x + left.rect.w;
  const rightEdge = right.rect.x;
  const lowerBottom = Math.min(left.rect.y, right.rect.y);
  const higherTop = Math.max(left.rect.y + left.rect.h, right.rect.y + right.rect.h);
  const size = Math.max(left.style.fontSizePt, right.style.fontSizePt);
  const spanSlack = Math.max(0.5, size * 0.3);
  return ruleLines.some((rule) => {
    if (rule.pageIndex !== left.pageIndex || rule.orientation !== 'vertical') return false;
    const x = (rule.x1 + rule.x2) / 2;
    const bottom = Math.min(rule.y1, rule.y2);
    const top = Math.max(rule.y1, rule.y2);
    return x > leftEdge - 0.5
      && x < rightEdge + 0.5
      && bottom <= lowerBottom + spanSlack
      && top >= higherTop - spanSlack;
  });
}

interface RowGap {
  readonly gap: number;
  readonly size: number;
}

/** Split one baseline into local click units using only its runs and crossing borders. */
export function splitTextRow(
  runs: readonly TextRun[],
  ruleLines: readonly RuleLine[],
): readonly (readonly TextRun[])[] {
  const ordered = [...runs].sort((left, right) => left.rect.x - right.rect.x);
  const wideGaps = ordered.slice(1).flatMap<RowGap>((run, index) => {
    const previous = ordered[index];
    if (!previous) return [];
    const gap = run.rect.x - (previous.rect.x + previous.rect.w);
    const size = Math.max(previous.style.fontSizePt, run.style.fontSizePt);
    return gap > Math.max(18, size * 1.75) ? [{ gap, size }] : [];
  });
  const largestWideGap = Math.max(0, ...wideGaps.map(({ gap }) => gap));
  const stretchedLine = wideGaps.length >= 2 && wideGaps.every(({ gap, size }) => (
    gap >= largestWideGap * 0.8 && gap <= size * 3 + 0.5
  ));

  const pieces: TextRun[][] = [];
  let piece: TextRun[] = [];
  for (const run of ordered) {
    const previous = piece.at(-1);
    if (previous) {
      const gap = run.rect.x - (previous.rect.x + previous.rect.w);
      const size = Math.max(previous.style.fontSizePt, run.style.fontSizePt);
      const splitAtRule = verticalRuleSeparates(previous, run, ruleLines);
      const splitNumbers = isTableNumber(previous.text)
        && isTableNumber(run.text)
        && gap > Math.max(3, size * 0.4);
      const splitWide = gap > Math.max(18, size * 1.75) && !stretchedLine;
      if (splitAtRule || splitNumbers || splitWide) {
        pieces.push(piece);
        piece = [];
      }
    }
    piece.push(run);
  }
  if (piece.length > 0) pieces.push(piece);
  return pieces;
}

function horizontalRuleSeparates(
  upper: TextLine,
  lower: TextLine,
  ruleLines: readonly RuleLine[],
): boolean {
  const overlapLeft = Math.max(upper.rect.x, lower.rect.x);
  const overlapRight = Math.min(upper.rect.x + upper.rect.w, lower.rect.x + lower.rect.w);
  const narrower = upper.rect.w <= lower.rect.w ? upper.rect : lower.rect;
  const targetLeft = overlapRight > overlapLeft ? overlapLeft : narrower.x;
  const targetRight = overlapRight > overlapLeft ? overlapRight : narrower.x + narrower.w;
  return ruleLines.some((rule) => {
    if (rule.pageIndex !== upper.pageIndex || rule.orientation !== 'horizontal') return false;
    const y = (rule.y1 + rule.y2) / 2;
    const left = Math.min(rule.x1, rule.x2);
    const right = Math.max(rule.x1, rule.x2);
    return y > lower.baselineY
      && y < upper.baselineY
      && left <= targetLeft + 1
      && right >= targetRight - 1;
  });
}

function fontFamily(fontName: string): 'serif' | 'sans' | 'mono' {
  if (/sans[-_\s]*serif/i.test(fontName)) return 'sans';
  if (/times|georgia|serif|cambria|garamond|minion|book[-_\s]*antiqua|palatino|baskerville|bodoni|constantia|merriweather/i.test(fontName)) {
    return 'serif';
  }
  if (/courier|mono|consolas/i.test(fontName)) return 'mono';
  return 'sans';
}

/**
 * The weight a line's font carries, ignoring bold that was painted onto a
 * phrase with fill-and-stroke. Grouping must judge lines by their face: a bold
 * phrase inside a sentence is emphasis, not the start of a new paragraph.
 */
export function intrinsicBold(style: TextStyle): boolean {
  return style.sourceBold ?? style.bold;
}

function sameParagraphStyle(upper: TextLine, lower: TextLine, size: number): boolean {
  return Math.abs(upper.style.fontSizePt - lower.style.fontSizePt) <= Math.max(1.5, size * 0.22)
    && fontFamily(upper.style.fontName) === fontFamily(lower.style.fontName)
    && intrinsicBold(upper.style) === intrinsicBold(lower.style)
    && upper.style.italic === lower.style.italic;
}

export function startsWithBulletMarker(text: string): boolean {
  return TEXT_BULLET.test(text);
}

/** A dot drawn beside a line rather than typed into it — an image or a vector shape. */
export interface DrawnMarker {
  readonly pageIndex: number;
  readonly rect: PdfRect;
}

// Mirrors the geometry `bulletList.ts` uses to claim a marker for a line. Grouping only
// needs to know a dot is there, so this stays deliberately simple; the list itself is
// still detected by bulletList.ts afterwards with its stricter rule.
const MIN_MARKER_SIZE_PT = 1;
const MAX_MARKER_SIZE_PT = 7;
const MIN_LEFT_GAP_PT = 0.5;
const MAX_LEFT_GAP_PT = 16;

/** Is there a small drawn dot immediately left of this line, on its own baseline? */
export function lineHasDrawnMarker(
  line: TextLine,
  markers: readonly DrawnMarker[],
): boolean {
  return markers.some((marker) => {
    if (marker.pageIndex !== line.pageIndex) return false;
    const { rect } = marker;
    const size = Math.max(rect.w, rect.h);
    const aspectRatio = rect.w / Math.max(0.001, rect.h);
    if (
      size < MIN_MARKER_SIZE_PT
      || size > Math.min(MAX_MARKER_SIZE_PT, line.style.fontSizePt * 0.85)
      || aspectRatio < 0.65
      || aspectRatio > 1.55
    ) return false;
    const leftGap = line.rect.x - (rect.x + rect.w);
    if (leftGap < MIN_LEFT_GAP_PT || leftGap > MAX_LEFT_GAP_PT) return false;
    const centerY = rect.y + rect.h / 2;
    const expectedCenterY = line.baselineY + line.style.fontSizePt * 0.34;
    return Math.abs(centerY - expectedCenterY) <= Math.max(1.5, line.style.fontSizePt * 0.34);
  });
}

/** Decide whether the next line continues the local paragraph immediately above it. */
export function canJoinTextBlock(
  lines: readonly TextLine[],
  line: TextLine,
  ruleLines: readonly RuleLine[],
  markers: readonly DrawnMarker[] = [],
): boolean {
  const previous = lines.at(-1);
  if (!previous || previous.pageIndex !== line.pageIndex) return false;
  if (isTableNumber(previous.text) || isTableNumber(line.text)) return false;
  if (horizontalRuleSeparates(previous, line, ruleLines)) return false;

  const size = Math.max(previous.style.fontSizePt, line.style.fontSizePt);
  const verticalGap = previous.baselineY - line.baselineY;
  if (verticalGap <= 0.5 || verticalGap > size * 1.85) return false;
  if (!sameParagraphStyle(previous, line, size)) return false;

  const startDelta = Math.abs(previous.rect.x - line.rect.x);
  const overlap = Math.max(
    0,
    Math.min(previous.rect.x + previous.rect.w, line.rect.x + line.rect.w)
      - Math.max(previous.rect.x, line.rect.x),
  );
  const overlapRatio = overlap / Math.max(1, Math.min(previous.rect.w, line.rect.w));
  if (startDelta > Math.max(9, size) && overlapRatio < 0.7) return false;

  if (lines.length >= 2) {
    const gaps = lines.slice(1).map((item, index) => (
      (lines[index]?.baselineY ?? item.baselineY) - item.baselineY
    ));
    const expected = median(gaps);
    if (Math.abs(verticalGap - expected) > Math.max(2, expected * 0.35)) return false;
  }

  // A list item's own first line need not reach the block's widest edge — items differ in
  // length — so its wrapped continuation must not be judged by that test.
  const previousStartsItem = startsWithBulletMarker(previous.text)
    || lineHasDrawnMarker(previous, markers);
  if (!previousStartsItem) {
    // A paragraph ends on a SHORT line, not merely on a full stop: prose is full of
    // sentences that end mid-paragraph, and 320 line pairs across the 45 test files were
    // being split at one. Ending a sentence only ends the block when the line also stops
    // short of the text's right edge.
    const widestRight = Math.max(...[...lines, line].map((item) => item.rect.x + item.rect.w));
    if (widestRight - (previous.rect.x + previous.rect.w) > size * 2) return false;
  }
  if (startsWithBulletMarker(line.text)) return false;
  return true;
}

/**
 * Consecutive bullets remain one list block, not a prose paragraph — whether the marker
 * is typed into the line or drawn beside it. A drawn-marker list depends on this: its
 * items carry no dot in their text, so the paragraph rules above see only short lines
 * ending in full stops and would leave every item in a block of its own, which is too
 * few for `bulletList.ts` to recognise a list at all.
 */
export function canJoinTextBulletList(
  lines: readonly TextLine[],
  line: TextLine,
  ruleLines: readonly RuleLine[],
  markers: readonly DrawnMarker[] = [],
): boolean {
  const previous = lines.at(-1);
  const marker = lines.find((candidate) => (
    startsWithBulletMarker(candidate.text) || lineHasDrawnMarker(candidate, markers)
  ));
  const lineIsItem = startsWithBulletMarker(line.text) || lineHasDrawnMarker(line, markers);
  if (!previous || !marker || !lineIsItem) {
    return false;
  }
  if (previous.pageIndex !== line.pageIndex || horizontalRuleSeparates(previous, line, ruleLines)) {
    return false;
  }
  const size = Math.max(previous.style.fontSizePt, line.style.fontSizePt);
  const verticalGap = previous.baselineY - line.baselineY;
  return verticalGap > 0.5
    && verticalGap <= size * 1.85
    && sameParagraphStyle(previous, line, size)
    && Math.abs(marker.rect.x - line.rect.x) <= Math.max(9, size);
}

/** Multi-line blocks use only their own edges; a single line keeps its existing page alignment. */
export function detectBlockAlignment(lines: readonly TextLine[]): TextAlignment {
  if (lines.length < 2) return lines[0]?.align ?? 'left';
  const size = Math.max(...lines.map((line) => line.style.fontSizePt));
  const tolerance = Math.max(2, size * 0.15);
  const aligned = (values: readonly number[]) => (
    Math.max(...values) - Math.min(...values) <= tolerance
  );
  if (aligned(lines.map((line) => line.rect.x))) return 'left';
  if (aligned(lines.map((line) => line.rect.x + line.rect.w))) return 'right';
  if (aligned(lines.map((line) => line.rect.x + line.rect.w / 2))) return 'center';
  return 'left';
}
