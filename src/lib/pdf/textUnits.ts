import type { PdfRect, TextAlignment, TextStyle } from '@/lib/export/types';
import type { RuleLine } from './ruleLines';
import type { TextLine, TextRun } from './textContent';

const TEXT_BULLET = /^\s*[\uF0B7\uF0A7\uF0A8\uF0D8\uF06C\uF075\uF0FC\uF0FD\u2022\u25CF\u25AA\u25E6\u2023\u2043\u00B7\u2219➢]/u;

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

export function fontFamily(fontName: string): 'serif' | 'sans' | 'mono' {
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
  return drawnMarkerForLine(line, markers) !== undefined;
}

function drawnMarkerForLine(line: TextLine, markers: readonly DrawnMarker[]): DrawnMarker | undefined {
  return markers.find((marker) => {
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
function canJoinTextBlockLegacy(
  lines: readonly TextLine[],
  line: TextLine,
  ruleLines: readonly RuleLine[],
  markers: readonly DrawnMarker[] = [],
  preserveBulletTails = false,
): boolean {
  const previous = lines.at(-1);
  if (!previous || previous.pageIndex !== line.pageIndex) return false;
  if (isTableNumber(previous.text) || isTableNumber(line.text)) return false;
  if (horizontalRuleSeparates(previous, line, ruleLines)) return false;

  const size = Math.max(previous.style.fontSizePt, line.style.fontSizePt);
  const verticalGap = previous.baselineY - line.baselineY;
  if (verticalGap <= 0.5 || verticalGap > size * 1.85) return false;
  if (!sameParagraphStyle(previous, line, size)) return false;
  // Scans the group and every marker, so only for lines that can join at all.
  if (!preserveBulletTails && !continuesBulletItem(lines, line, markers)) return false;

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

/** Continuations may move slightly left of the body, but never back across its dot. */
function continuesBulletItem(lines: readonly TextLine[], lower: TextLine, markers: readonly DrawnMarker[]): boolean {
  if (startsWithBulletMarker(lower.text) || lineHasDrawnMarker(lower, markers)) return true;
  const item = [...lines].reverse().find((line) => startsWithBulletMarker(line.text) || lineHasDrawnMarker(line, markers));
  if (!item) return true;
  const drawn = drawnMarkerForLine(item, markers);
  const typed = item.runs.find((run) => startsWithBulletMarker(run.text));
  const right = drawn ? drawn.rect.x + drawn.rect.w : typed ? typedMarkerRight(typed) ?? item.rect.x : item.rect.x;
  if (lower.rect.x >= right - 1) return true;
  // Ziro's typed bullets have genuine hanging wraps back at the dot's LEFT
  // edge. Keep only a measured continuation of an unfinished
  // full line there; a margin note (NMAT) has neither geometry nor proof.
  const markerLeft = drawn?.rect.x ?? typed?.rect.x ?? item.rect.x;
  const previous = lines.at(-1)!;
  const edge = Math.max(...lines.map(line => line.rect.x + line.rect.w));
  const word = firstWordWidthPt(lower);
  return lower.rect.x >= markerLeft - 1
    && (/^\p{Ll}/u.test(lower.text.trim()) || /[,&;:/–—-]$/u.test(previous.text.trim()))
    && !/[.!?][’”'")\]]?$/u.test(previous.text.trim())
    && word !== undefined && word + (lower.runs[0]?.spaceWidthPt ?? 0)
      > edge - previous.rect.x - previous.rect.w + 0.5;
}

/** The dot's right edge, also when the item's words share its run; unknown advances fail closed. */
function typedMarkerRight(run: TextRun): number | undefined {
  if (run.text.trim().length === 1) return run.rect.x + run.rect.w;
  const characters = [...run.text];
  const advances = run.characterWidthsPt;
  if (!advances || advances.length !== characters.length) return undefined;
  const marker = characters.findIndex((character) => /\S/u.test(character));
  return run.rect.x + advances.slice(0, marker + 1).reduce((a, b) => a + b, 0);
}

/** Spacing-led joins for non-list boxes; caller freezes entire marker/list boxes. */
export function canJoinFillerTextBlock(
  lines: readonly TextLine[], line: TextLine, ruleLines: readonly RuleLine[],
  markers: readonly DrawnMarker[] = [], pageLines: readonly TextLine[] = [],
): boolean {
  const previous = lines.at(-1);
  if (!previous || previous.pageIndex !== line.pageIndex) return false;
  if (isTableNumber(previous.text) || isTableNumber(line.text) || horizontalRuleSeparates(previous, line, ruleLines)) return false;
  if ([...lines, line].some((item) => startsWithBulletMarker(item.text) || lineHasDrawnMarker(item, markers))) return false;
  const size = Math.max(previous.style.fontSizePt, line.style.fontSizePt);
  const gap = previous.baselineY - line.baselineY;
  if (gap <= 0.5 || gap > size * 1.85 || Math.abs(previous.style.fontSizePt - line.style.fontSizePt) > Math.max(1.5, size * 0.22)) return false;
  if (fontFamily(previous.style.fontName) !== fontFamily(line.style.fontName)) return false;
  if (Math.min(previous.rect.x + previous.rect.w, line.rect.x + line.rect.w) <= Math.max(previous.rect.x, line.rect.x)) return false;
  // Keep the measured borderless-table protection: overlapping cells in one
  // table column are not permission to collapse different rows into a paragraph.
  if ([previous, line].some((item) => pageLines.some((other) => other !== item
    && other.pageIndex === item.pageIndex && Math.abs(other.baselineY - item.baselineY) <= Math.max(1.5, size * 0.18)
    && (other.rect.x - (item.rect.x + item.rect.w) > Math.max(18, size * 1.75)
      || item.rect.x - (other.rect.x + other.rect.w) > Math.max(18, size * 1.75))))) return false;
  if (lines.length >= 2) {
    const expected = median(lines.slice(1).map((item, index) => lines[index]!.baselineY - item.baselineY));
    if (Math.abs(gap - expected) > Math.max(2, expected * 0.35)) return false;
  }
  return true;
}

/** Run fragmentation must not turn inline emphasis into a paragraph boundary. */
export function paragraphWeight(line: TextLine): 'bold' | 'regular' | 'mixed' {
  let bold = 0, regular = 0;
  for (const run of line.runs) {
    const count = [...run.text].filter((character) => /\p{L}/u.test(character)).length;
    if (intrinsicBold(run.style)) bold += count; else regular += count;
  }
  if (!bold && !regular) return intrinsicBold(line.style) ? 'bold' : 'regular';
  return bold && regular ? 'mixed' : bold ? 'bold' : 'regular';
}

/** First word in the line's own run geometry; unknown partial advances fail closed. */
export function firstWordWidthPt(line: TextLine): number | undefined {
  const word = line.text.trim().match(/^\S+/u)?.[0];
  if (!word) return undefined;
  let remaining = word, left: number | undefined, right: number | undefined;
  for (const run of [...line.runs].sort((a, b) => a.rect.x - b.rect.x)) {
    const text = run.text.trimStart();
    if (!text) continue;
    const part = text.split(/\s/u)[0] ?? '';
    if (!remaining.startsWith(part)) return undefined;
    const leading = [...run.text].length - [...text].length;
    const count = [...part].length;
    let start = 0, width = run.rect.w;
    if (leading || part !== run.text) {
      const advances = run.characterWidthsPt;
      if (!advances || advances.length !== [...run.text].length) return undefined;
      start = advances.slice(0, leading).reduce((a, b) => a + b, 0);
      width = advances.slice(leading, leading + count).reduce((a, b) => a + b, 0);
    }
    left ??= run.rect.x + start;
    right = run.rect.x + start + width;
    remaining = remaining.slice(part.length);
    if (!remaining) return right - left;
  }
  return undefined;
}

function startsParagraphItem(line: TextLine): boolean {
  return startsWithBulletMarker(line.text)
    || /^\s*©/u.test(line.text)
    || /^\s*\((?:[a-z]|[ivxlcdm]+|\d+)\)(?:\s|$)/iu.test(line.text)
    || /^\s*(?:[a-z]|[ivxlcdm]+)\.\s/iu.test(line.text)
    || /^\s*(?:[-–—*]\s*\p{L}|\d{1,2}[:.]\d{2}|\d+(?:\.\d+)*[.)%]?\s|day\s*[-–]?\s*\d)/iu.test(line.text);
}

/** Same-face fact/packing lines form a uniform block, independent of length. */
export function canJoinUniformTextBlock(
  lines: readonly TextLine[], line: TextLine, ruleLines: readonly RuleLine[],
  markers: readonly DrawnMarker[] = [], pageLines: readonly TextLine[] = [],
): boolean {
  const previous = lines.at(-1);
  if (!previous || previous.pageIndex !== line.pageIndex) return false;
  if (isTableNumber(previous.text) || isTableNumber(line.text) || horizontalRuleSeparates(previous, line, ruleLines)) return false;
  const size = Math.max(previous.style.fontSizePt, line.style.fontSizePt);
  const gap = previous.baselineY - line.baselineY;
  if (gap <= 0.5 || gap > size * 1.85 || Math.abs(previous.style.fontSizePt - line.style.fontSizePt) > 0.5) return false;
  if (fontFamily(previous.style.fontName) !== fontFamily(line.style.fontName)
    || previous.style.italic !== line.style.italic || Math.abs(previous.rect.x - line.rect.x) > 2) return false;
  const weight = paragraphWeight(previous);
  if (weight === 'mixed' || weight !== paragraphWeight(line)) return false;
  if ([...lines, line].some((item) => startsParagraphItem(item) || isTableNumber(item.text) || lineHasDrawnMarker(item, markers))) return false;
  // Borderless tables can have a multi-line name opposite one vertically
  // centred value. Either row's parallel cell is sufficient table evidence.
  const hasParallelCell = (item: TextLine) => pageLines.some((other) => (
    other !== item && other.pageIndex === item.pageIndex
    && Math.abs(other.baselineY - item.baselineY) <= Math.max(1.5, size * 0.18)
    && (other.rect.x - (item.rect.x + item.rect.w) > Math.max(18, size * 1.75)
      || item.rect.x - (other.rect.x + other.rect.w) > Math.max(18, size * 1.75))
  ));
  if (hasParallelCell(previous) || hasParallelCell(line)) return false;
  if (lines.length >= 2) {
    const expected = median(lines.slice(1).map((item, index) => lines[index]!.baselineY - item.baselineY));
    if (Math.abs(gap - expected) > expected * 0.1 + 0.001) return false;
  }
  return true;
}

/** Old joins win unconditionally. Only an evidenced wrap can override weight/shortness. */
export function canJoinTextBlock(
  lines: readonly TextLine[], line: TextLine, ruleLines: readonly RuleLine[],
  markers: readonly DrawnMarker[] = [], pageLines: readonly TextLine[] = [],
  preserveBulletTails = false,
): boolean {
  if (canJoinTextBlockLegacy(lines, line, ruleLines, markers, preserveBulletTails)) return true;
  const previous = lines.at(-1);
  if (!previous || previous.pageIndex !== line.pageIndex || !pageLines.length) return false;
  if (isTableNumber(previous.text) || isTableNumber(line.text) || horizontalRuleSeparates(previous, line, ruleLines)) return false;
  const size = Math.max(previous.style.fontSizePt, line.style.fontSizePt);
  const gap = previous.baselineY - line.baselineY;
  if (gap <= 0.5 || gap > size * 1.85 || Math.abs(previous.style.fontSizePt - line.style.fontSizePt) > 0.5) return false;
  if (fontFamily(previous.style.fontName) !== fontFamily(line.style.fontName) || previous.style.italic !== line.style.italic) return false;
  // New bridges are only for a single left edge, not headings indented over prose.
  if (Math.abs(previous.rect.x - line.rect.x) > 2) return false;
  if (lines.some((item) => startsParagraphItem(item) || lineHasDrawnMarker(item, markers))
    || startsParagraphItem(line) || lineHasDrawnMarker(line, markers)) return false;
  if (lines.length >= 2) {
    const expected = median(lines.slice(1).map((item, index) => lines[index]!.baselineY - item.baselineY));
    // A paragraph boundary with extra leading is not a wrap, even when the old
    // permissive 35% line-rhythm guard would have just let it through.
    if (Math.abs(gap - expected) > Math.max(1, size * 0.15)) return false;
  }
  const previousRight = previous.rect.x + previous.rect.w;
  const peers = pageLines.filter((other) => other !== previous && other.pageIndex === previous.pageIndex
    && Math.abs(other.rect.x - previous.rect.x) <= 2);
  if (!peers.some((other) => other.rect.x + other.rect.w >= previousRight - 2)) return false;
  const columnRight = Math.max(...peers.map((other) => other.rect.x + other.rect.w), previousRight);
  if (columnRight - previous.rect.x < size * 20) return false;
  const upperWeight = paragraphWeight(previous), lowerWeight = paragraphWeight(line);
  const sameWeight = upperWeight === lowerWeight || upperWeight === 'mixed' || lowerWeight === 'mixed';
  const upperText = previous.text.trim(), lowerText = line.text.trim();
  if (sameWeight && /[.!?](?:['’”")]|\])?$/u.test(upperText) && /^\p{Lu}/u.test(lowerText)) return false;
  // A capitalized plain item/title with no punctuation linking it to the upper
  // line is ambiguous (GOA inclusions). Keep its existing boundary. Mixed
  // Highlights runs and a comma followed by a proper noun remain eligible.
  if (sameWeight && lowerWeight !== 'mixed' && /^\p{Lu}/u.test(lowerText)
    && !/[,;:–—-]$/u.test(upperText)) return false;
  const wordWidth = firstWordWidthPt(line);
  const separator = line.runs[0]?.spaceWidthPt ?? 0;
  return wordWidth !== undefined && Number.isFinite(wordWidth) && Number.isFinite(separator)
    && wordWidth + separator > columnRight - previousRight + 0.5;
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
