import { OPS } from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { PdfRect, TextAlignment, TextStyle } from '@/lib/export/types';
import { viewportToPdf } from '@/lib/export/coordinates';
import type { PdfPt, ViewportPt } from '@/lib/export/coordinates';
import { registerPdfJsFontReference } from '@/lib/export/embeddedFont';
import { pageFontTracking, registerSourceFont, sourceFontIdentity } from '@/lib/fonts/fontMatch';
import { ensureMatchedFont, prepareSourceFont } from '@/lib/fonts/twinFonts';
import { dropCoveredTextRuns, mapTextItemsToOperators } from './hiddenText';
import { resolveTextPaint, textPaintForItems } from './textPaint';
import type { RuleLine } from './ruleLines';
import type { DrawnMarker } from './textUnits';
import { biggerParagraphGap, inRuledColumn, pageLinePitches } from './paragraphPitch';
import { sourceTextMetrics, textStatesForItems } from './textMetrics';
import type { SourceLineMetrics, SourceTextMetrics } from './textMetrics';
import { rawSpacing, runKey } from './wordSpacing';
import type { RawSpacing } from './wordSpacing';
import { justifiedBlock } from './justification';
import {
  canJoinTextBlock,
  canJoinTextBulletList,
  canJoinFillerTextBlock,
  canJoinUniformTextBlock,
  detectBlockAlignment,
  intrinsicBold,
  lineHasDrawnMarker,
  startsWithBulletMarker,
  splitTextRow,
} from './textUnits';

export { isTableNumber } from './textUnits';

export interface TextRun {
  readonly pageIndex: number;
  readonly text: string;
  readonly rect: PdfRect;
  readonly style: TextStyle;
  /** Glyph-weighted advances normalized to this run's measured width; grouping only. */
  readonly characterWidthsPt?: readonly number[];
  readonly spaceWidthPt?: number;
  readonly metrics?: SourceTextMetrics;
  readonly wordSpacing?: RawSpacing;
  /** Page decoration such as a watermark: left on the page, never edited or translated. */
  readonly background?: true;
}

export interface TextLine {
  readonly pageIndex: number;
  readonly text: string;
  readonly rect: PdfRect;
  readonly baselineY: number;
  readonly style: TextStyle;
  readonly runs: readonly TextRun[];
  readonly align?: TextAlignment;
  readonly alignLeftPt?: number;
  readonly alignWidthPt?: number;
  readonly metrics?: SourceLineMetrics;
}

export interface TextBlock {
  readonly pageIndex: number;
  readonly text: string;
  readonly rect: PdfRect;
  readonly topBaselineY: number;
  readonly lineHeightPt: number;
  /** Measured page pitch for paragraph-aware editing; legacy sessions ignore it. */
  readonly paragraphLineHeightPt?: number;
  readonly style: TextStyle;
  readonly lines: readonly TextLine[];
  readonly paragraphMinimumWordGapsEm?: readonly (number | undefined)[];
  readonly align?: TextAlignment;
  readonly alignLeftPt?: number;
  readonly alignWidthPt?: number;
}

export type FontFamilyClass = 'serif' | 'sans' | 'mono';

const WORD_SYMBOL_BULLET = '\uF0B7';
const STANDARD_BULLET = '\u2022';

/** Reduce arbitrary PDF font names to the three families both renderers support. */
export function classifyFontFamily(fontName: string): FontFamilyClass {
  if (/sans[-_\s]*serif/i.test(fontName)) return 'sans';
  if (/times|georgia|serif|cambria|garamond|minion|book[-_\s]*antiqua|palatino|baskerville|bodoni|constantia|merriweather/i.test(fontName)) return 'serif';
  if (/courier|mono|consolas/i.test(fontName)) return 'mono';
  return 'sans';
}

function unionRects(rects: readonly PdfRect[]): PdfRect {
  const first = rects[0];
  if (!first) return { x: 0, y: 0, w: 0, h: 0 };

  let minX = first.x;
  let minY = first.y;
  let maxX = first.x + first.w;
  let maxY = first.y + first.h;
  for (const rect of rects.slice(1)) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function representativeStyle(runs: readonly TextRun[]): TextStyle {
  return runs.reduce((best, run) => (
    run.text.trim().length > best.text.trim().length ? run : best
  )).style;
}

function lineText(runs: readonly TextRun[]): string {
  const [first, ...rest] = runs;
  if (!first) return '';

  let text = first.text.trim();
  let previous = first;
  for (const run of rest) {
    const part = run.text.trim();
    if (!part) continue;
    const gap = run.rect.x - (previous.rect.x + previous.rect.w);
    const spaceThreshold = Math.max(
      0.75,
      Math.min(previous.style.fontSizePt, run.style.fontSizePt) * 0.08,
    );
    const punctuation = /^[,.;:!?%)}\]]/.test(part) || '([{/'.includes(text.at(-1) ?? '');
    if (gap > spaceThreshold && !punctuation) text += ' ';
    text += part;
    previous = run;
  }
  return text;
}

function makeLine(runs: readonly TextRun[]): TextLine {
  const style = representativeStyle(runs);
  return {
    pageIndex: runs[0]?.pageIndex ?? 0,
    text: lineText(runs),
    rect: unionRects(runs.map((run) => run.rect)),
    baselineY: runs.reduce((sum, run) => sum + run.rect.y, 0) / Math.max(1, runs.length),
    style,
    runs,
    ...(runs[0]?.metrics ? { metrics: { x: runs[0].metrics.x, baselineY: runs[0].metrics.baselineY } } : {}),
  };
}

function isStandaloneNumber(text: string): boolean {
  return /^[\d.,/-]{1,6}$/.test(text.trim());
}

export interface TextGroupingOptions {
  /** Historical partition for saved edits and Change-10 corpus comparisons. */
  readonly preserveParagraphGaps?: boolean;
  readonly ruleLines: readonly RuleLine[];
  /** Compatibility partition for saved-project anchors and corpus comparisons. */
  readonly preserveParagraphSplits?: boolean;
  /** Measure Change 5 separately against the already-reviewed wrap exception. */
  readonly preserveUniformSplits?: boolean;
  /** Measurements and saved anchors use the pre-Change-7/9 partition. */
  readonly preserveFillerSplits?: boolean;
  readonly preserveBulletTails?: boolean;
  /**
   * Dots drawn beside lines rather than typed into them. Without these a drawn-marker
   * bullet list never groups, so `bulletList.ts` cannot recognise it and the list loses
   * its bullet editing entirely.
   */
  readonly markers?: readonly DrawnMarker[];
}

/** Infer a line's alignment against the horizontal content bounds of its page. */
export function detectTextAlignment(
  rect: PdfRect,
  contentLeft: number,
  contentRight: number,
  fontSizePt: number,
): TextAlignment {
  const contentWidth = Math.max(0, contentRight - contentLeft);
  const leftGap = Math.max(0, rect.x - contentLeft);
  const rightGap = Math.max(0, contentRight - (rect.x + rect.w));
  const tolerance = Math.max(1, fontSizePt);
  // A cover-page heading can nearly span the widest text on the page; a small,
  // balanced inset is still meaningful alignment evidence.
  const meaningfulGap = Math.max(1.5, fontSizePt * 0.12);

  if (
    leftGap >= meaningfulGap &&
    rightGap >= meaningfulGap &&
    Math.abs(leftGap - rightGap) <= tolerance
  ) {
    return 'center';
  }
  if (
    rightGap <= tolerance &&
    leftGap >= Math.max(fontSizePt * 2, contentWidth * 0.2)
  ) {
    return 'right';
  }
  return 'left';
}

/** Merge PDF.js fragments first by baseline and then by natural horizontal gaps. */
export function mergeRunsIntoLines(
  runs: readonly TextRun[],
  options?: TextGroupingOptions,
): TextLine[] {
  const rows: Array<{ pageIndex: number; baselineY: number; runs: TextRun[] }> = [];
  const sorted = [...runs].sort(
    (left, right) =>
      left.pageIndex - right.pageIndex ||
      right.rect.y - left.rect.y ||
      left.rect.x - right.rect.x,
  );

  for (const run of sorted) {
    const tolerance = Math.max(1.5, run.style.fontSizePt * 0.18);
    const row = rows
      .filter((candidate) => candidate.pageIndex === run.pageIndex)
      .sort(
        (left, right) =>
          Math.abs(left.baselineY - run.rect.y) - Math.abs(right.baselineY - run.rect.y),
      )
      .find((candidate) => Math.abs(candidate.baselineY - run.rect.y) <= tolerance);
    if (row) {
      row.runs.push(run);
      row.baselineY = row.runs.reduce((sum, item) => sum + item.rect.y, 0) / row.runs.length;
    } else {
      rows.push({ pageIndex: run.pageIndex, baselineY: run.rect.y, runs: [run] });
    }
  }

  const lines: TextLine[] = [];
  for (const row of rows) {
    const ordered = row.runs.sort((left, right) => left.rect.x - right.rect.x);
    if (options) {
      lines.push(...splitTextRow(ordered, options.ruleLines).map(makeLine));
      continue;
    }
    let segment: TextRun[] = [];
    for (const run of ordered) {
      const previous = segment.at(-1);
      const gap = previous ? run.rect.x - (previous.rect.x + previous.rect.w) : 0;
      const columnGap = Math.max(
        18,
        Math.max(previous?.style.fontSizePt ?? 0, run.style.fontSizePt) * 1.75,
      );
      const separateNumbers = previous &&
        isStandaloneNumber(previous.text) &&
        isStandaloneNumber(run.text) &&
        gap > Math.max(3, run.style.fontSizePt * 0.4);
      if (previous && (gap > columnGap || separateNumbers)) {
        lines.push(makeLine(segment));
        segment = [];
      }
      segment.push(run);
    }
    if (segment.length > 0) lines.push(makeLine(segment));
  }

  const contentBounds = new Map<number, { left: number; right: number }>();
  for (const run of runs) {
    const existing = contentBounds.get(run.pageIndex);
    const right = run.rect.x + run.rect.w;
    if (existing) {
      existing.left = Math.min(existing.left, run.rect.x);
      existing.right = Math.max(existing.right, right);
    } else {
      contentBounds.set(run.pageIndex, { left: run.rect.x, right });
    }
  }

  return lines.map((line) => {
    const bounds = contentBounds.get(line.pageIndex) ?? {
      left: line.rect.x,
      right: line.rect.x + line.rect.w,
    };
    return {
      ...line,
      align: detectTextAlignment(
        line.rect,
        bounds.left,
        bounds.right,
        line.style.fontSizePt,
      ),
      alignLeftPt: bounds.left,
      alignWidthPt: Math.max(0, bounds.right - bounds.left),
      ...(line.metrics ? { metrics: { ...line.metrics, alignmentLeftPt: bounds.left, alignmentWidthPt: Math.max(0, bounds.right - bounds.left) } } : {}),
    };
  }).sort(
    (left, right) =>
      left.pageIndex - right.pageIndex ||
      right.baselineY - left.baselineY ||
      left.rect.x - right.rect.x,
  ).map((line, index, lines) => {
    const next = lines.slice(index + 1).find(candidate => candidate.pageIndex === line.pageIndex && candidate.baselineY < line.baselineY
      && candidate.rect.x < line.rect.x + line.rect.w && candidate.rect.x + candidate.rect.w > line.rect.x);
    return line.metrics && next ? { ...line, metrics: { ...line.metrics, lineSpacingPt: line.baselineY - next.baselineY } } : line;
  });
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle] ?? 0;
  return ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

function canJoinBlock(
  lines: readonly TextLine[],
  line: TextLine,
  options?: TextGroupingOptions,
): boolean {
  if (options) {
    return canJoinTextBlock(lines, line, options.ruleLines, options.markers ?? [], [], options.preserveBulletTails)
      || canJoinTextBulletList(lines, line, options.ruleLines, options.markers ?? []);
  }
  const previous = lines.at(-1);
  if (!previous || previous.pageIndex !== line.pageIndex) return false;
  if (isStandaloneNumber(previous.text) || isStandaloneNumber(line.text)) return false;

  const verticalGap = previous.baselineY - line.baselineY;
  const size = Math.max(previous.style.fontSizePt, line.style.fontSizePt);
  if (verticalGap <= 0.5 || verticalGap > size * 1.85) return false;
  if (Math.abs(previous.style.fontSizePt - line.style.fontSizePt) > Math.max(1.5, size * 0.22)) {
    return false;
  }
  if (
    classifyFontFamily(previous.style.fontName) !== classifyFontFamily(line.style.fontName) ||
    // Inline mode-2 weight is rich appearance, not a paragraph boundary. Keep
    // source grouping based on the face's intrinsic weight as it was before
    // paint-aware bold was added; the runs still retain their desired B state.
    intrinsicBold(previous.style) !== intrinsicBold(line.style) ||
    previous.style.italic !== line.style.italic
  ) {
    return false;
  }

  const bulletLike =
    previous.runs[0]?.text.trim() === STANDARD_BULLET &&
    line.runs[0]?.text.trim() === STANDARD_BULLET;
  const paragraphLike =
    previous.text.length >= 24 ||
    line.text.length >= 24 ||
    previous.runs.length >= 3 ||
    line.runs.length >= 3 ||
    bulletLike;
  if (!paragraphLike) return false;

  const startDelta = Math.abs(previous.rect.x - line.rect.x);
  const overlap = Math.max(
    0,
    Math.min(previous.rect.x + previous.rect.w, line.rect.x + line.rect.w) -
      Math.max(previous.rect.x, line.rect.x),
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
  return true;
}

/** Group natural wrapped lines into editable paragraph blocks while keeping short fields standalone. */
export function groupRunsIntoBlocks(
  runs: readonly TextRun[],
  options?: TextGroupingOptions,
): TextBlock[] {
  const lineGroups: TextLine[][] = [];
  const pageLines = mergeRunsIntoLines(runs, options);
  for (const line of pageLines) {
    const candidates = lineGroups
      .filter((group) => canJoinBlock(group, line, options))
      .sort((left, right) => {
        const leftLast = left.at(-1);
        const rightLast = right.at(-1);
        return (
          Math.abs((leftLast?.rect.x ?? 0) - line.rect.x) -
          Math.abs((rightLast?.rect.x ?? 0) - line.rect.x)
        );
      });
    const target = candidates[0];
    if (target) target.push(line);
    else lineGroups.push([line]);
  }

  // Freeze today's partition first. A new bridge must never change the target
  // chosen for a later line, or it can SPLIT an existing box (prototype's bug).
  if (options && !options.preserveParagraphSplits) {
    // Changes 1–6 remain the frozen starting partition, not just their older
    // legacy arm. Change 7 may add bridges but cannot undo a proven old wrap.
    for (const filler of options.preserveFillerSplits ? [false] : [false, true]) {
    const parents = lineGroups.map((_, index) => index);
    const root = (index: number): number => {
      while (parents[index] !== index) index = parents[index]!;
      return index;
    };
    const usedUpper = new Set<number>();
    const joinedLines = new Map(lineGroups.map((group, index) => [index, [...group]]));
    for (let lowerIndex = 1; lowerIndex < lineGroups.length; lowerIndex += 1) {
      const lower = lineGroups[lowerIndex]!;
      const first = lower[0]!;
      if (lower.some((line) => startsWithBulletMarker(line.text) || lineHasDrawnMarker(line, options.markers ?? []))) continue;
      const candidates = lineGroups.slice(0, lowerIndex).flatMap((upper, index) => {
        if (usedUpper.has(index)) return [];
        const connected = joinedLines.get(root(index))!;
        if (filler) {
          // Freeze the ENTIRE old list/marker box, including its heading and
          // unmarked continuations. Only checking its last line loses list ownership.
          if (connected.some((line) => startsWithBulletMarker(line.text) || lineHasDrawnMarker(line, options.markers ?? []))) return [];
          return canJoinFillerTextBlock(connected, first, options.ruleLines, options.markers, pageLines) ? [index] : [];
        }
        if (canJoinTextBlock(upper, first, options.ruleLines, options.markers, [], options.preserveBulletTails)) return [];
        return canJoinTextBlock(upper, first, options.ruleLines, options.markers, pageLines, options.preserveBulletTails)
          || (!options.preserveUniformSplits && canJoinUniformTextBlock(connected, first, options.ruleLines, options.markers, pageLines)) ? [index] : [];
      }).sort((a, b) => lineGroups[a]!.at(-1)!.baselineY - lineGroups[b]!.at(-1)!.baselineY);
      const upperIndex = candidates[0];
      if (upperIndex === undefined) continue;
      const upperRoot = root(upperIndex), lowerRoot = root(lowerIndex);
      joinedLines.set(upperRoot, [...joinedLines.get(upperRoot)!, ...joinedLines.get(lowerRoot)!]
        .sort((a, b) => b.baselineY - a.baselineY || a.rect.x - b.rect.x));
      joinedLines.delete(lowerRoot);
      parents[lowerRoot] = upperRoot;
      usedUpper.add(upperIndex);
    }
    const combined = new Map<number, TextLine[]>();
    lineGroups.forEach((group, index) => {
      const key = root(index);
      const bucket = combined.get(key) ?? [];
      bucket.push(...group);
      combined.set(key, bucket);
    });
    lineGroups.splice(0, lineGroups.length, ...[...combined.values()].map((lines) => (
      lines.sort((a, b) => b.baselineY - a.baselineY || a.rect.x - b.rect.x)
    )));
    }
  }
  const blocks = lineGroups.map((lines) => textBlockFromLines(lines, Boolean(options)));
  const aligned = (values: TextBlock[]) => values.map(block => justifiedBlock(block, options?.markers ?? []));
  if (!options || options.preserveParagraphGaps || options.preserveParagraphSplits || options.preserveFillerSplits) return aligned(blocks);
  const pitches = pageLinePitches(pageLines);
  return aligned(blocks.flatMap(block => {
    if (block.align !== 'left' || block.lines.some(line => startsWithBulletMarker(line.text) || lineHasDrawnMarker(line, options.markers ?? []))) return [block];
    const groups: TextLine[][] = [[]];
    const cell = inRuledColumn(block, options.ruleLines);
    block.lines.forEach((line, index) => {
      if (index && !cell && biggerParagraphGap(block.lines[index - 1]!, line, pitches)) groups.push([]);
      groups.at(-1)!.push(line);
    });
    return groups.map(lines => {
      const next = groups.length === 1 ? block : textBlockFromLines(lines);
      const counts = new Map<number, number>();
      for (const line of lines) {
        const pitch = pitches.get(line); if (pitch !== undefined) counts.set(pitch, (counts.get(pitch) ?? 0) + 1);
      }
      const normal = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
      return normal === undefined ? next : { ...next, paragraphLineHeightPt: normal };
    });
  }));
}

/** Rebuild a partition from the same source lines, without changing any style. */
export function textBlockFromLines(lines: readonly TextLine[], localAlignment = true): TextBlock {
    const style = lines[0]?.style ?? {
      fontName: 'Helvetica',
      fontSizePt: 12,
      bold: false,
      italic: false,
      color: { r: 0, g: 0, b: 0 },
    };
    const gaps = lines.slice(1).map((line, index) => (
      (lines[index]?.baselineY ?? line.baselineY) - line.baselineY
    ));
    const align = localAlignment ? detectBlockAlignment(lines) : (
      lines.every((line) => line.align === lines[0]?.align)
        ? (lines[0]?.align ?? 'left')
        : 'left'
    );
    const singleLine = lines.length === 1;
    const blockRect = unionRects(lines.map((line) => line.rect));
    return {
      pageIndex: lines[0]?.pageIndex ?? 0,
      text: lines.map((line) => line.text).join('\n'),
      rect: blockRect,
      topBaselineY: Math.max(...lines.map((line) => line.baselineY)),
      lineHeightPt: median(gaps) || style.fontSizePt * 1.2,
      style,
      lines,
      align,
      ...(singleLine ? {
        alignLeftPt: lines[0]?.alignLeftPt,
        alignWidthPt: lines[0]?.alignWidthPt,
      } : align === 'left' ? {} : {
        alignLeftPt: blockRect.x,
        alignWidthPt: blockRect.w,
      }),
    };
}

/** Keep an already-edited old box intact, including its trailing boundary. */
export function preserveEditedBlockPartitions(
  blocks: readonly TextBlock[], legacy: readonly TextBlock[],
  isEdited: (block: TextBlock) => boolean,
): TextBlock[] {
  const key = (line: TextLine) => JSON.stringify([line.pageIndex, line.baselineY, line.rect.x, line.text]);
  const editedLines = new Map<string, number>();
  legacy.forEach((block, index) => {
    if (isEdited(block)) block.lines.forEach((line) => editedLines.set(key(line), index));
  });
  if (!editedLines.size) return [...blocks];
  const emittedEdited = new Set<number>();
  return blocks.flatMap((block) => {
    if (!block.lines.length) return [block];
    const pieces: TextLine[][] = [];
    let previous: number | undefined;
    block.lines.forEach((line, index) => {
      const owner = editedLines.get(key(line));
      if (!index || owner !== previous) pieces.push([]);
      pieces.at(-1)!.push(line);
      previous = owner;
    });
    return pieces.flatMap((lines) => {
      const owner = editedLines.get(key(lines[0]!));
      if (owner === undefined) return [pieces.length === 1 ? block : textBlockFromLines(lines)];
      if (emittedEdited.has(owner)) return [];
      emittedEdited.add(owner);
      // Change 9 may detach an old list's tail. A saved edit still owns that
      // original complete box, not several freshly detected fragments.
      const saved = legacy[owner]!;
      // The same box regrouped: keep the current block, whose page pitch the
      // first edit used. A copy without it reopens at a different line pitch.
      if (pieces.length === 1 && saved.lines.length === block.lines.length
        && saved.lines.every((line, lineIndex) => key(line) === key(block.lines[lineIndex]!))) return [block];
      return [saved.paragraphLineHeightPt === undefined && block.paragraphLineHeightPt !== undefined
        ? { ...saved, paragraphLineHeightPt: block.paragraphLineHeightPt } : saved];
    });
  });
}

/** Own-font glyph widths, not average letters or a substitute browser font. */
function glyphWidthsByFont(operators: { fnArray: number[]; argsArray: unknown[][] }): Map<string, Map<string, number>> {
  const fonts = new Map<string, Map<string, number>>();
  let font = '';
  const stack: string[] = [];
  const collect = (value: unknown, widths: Map<string, number>) => {
    if (Array.isArray(value)) { value.forEach((entry) => collect(entry, widths)); return; }
    if (!value || typeof value !== 'object') return;
    const glyph = value as { unicode?: unknown; width?: unknown };
    if (typeof glyph.unicode !== 'string' || [...glyph.unicode].length !== 1
      || typeof glyph.width !== 'number' || !Number.isFinite(glyph.width) || glyph.width < 0) return;
    const previous = widths.get(glyph.unicode);
    widths.set(glyph.unicode, previous === undefined || previous === glyph.width ? glyph.width : NaN);
  };
  operators.fnArray.forEach((op, index) => {
    const args = operators.argsArray[index];
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push(font);
    if (op === OPS.restore || op === OPS.paintFormXObjectEnd) font = stack.pop() ?? '';
    if (op === OPS.setFont && typeof args?.[0] === 'string') font = args[0];
    if (![OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText].includes(op)) return;
    const widths = fonts.get(font) ?? new Map<string, number>();
    collect(args, widths);
    fonts.set(font, widths);
  });
  return fonts;
}

/** PDF.js Util.transform's affine-matrix multiplication, kept DOM-free for Node tests. */
function transform(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): [number, number, number, number, number, number] {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = Array.from(left);
  const [g = 0, h = 0, i = 0, j = 0, k = 0, l = 0] = Array.from(right);

  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}

/** Infer the style flags commonly encoded in embedded PDF font names. */
export function classifyFontStyle(fontName: string): {
  readonly bold: boolean;
  readonly italic: boolean;
} {
  return {
    bold: /bold|black|heavy|semibold|[6-9]00/i.test(fontName),
    italic: /italic|oblique/i.test(fontName),
  };
}

interface SfntStyleMetadata {
  readonly weight?: number;
  readonly macStyle?: number;
}

function sfntStyleMetadata(data: Uint8Array | undefined): SfntStyleMetadata | null {
  if (!data || data.length < 12) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numTables = view.getUint16(4);
  if (numTables === 0 || numTables > 64) return null;

  let os2Offset: number | null = null;
  let headOffset: number | null = null;
  for (let index = 0; index < numTables; index += 1) {
    const recordOffset = 12 + index * 16;
    if (recordOffset + 16 > data.length) return null;

    const tag = String.fromCharCode(
      data[recordOffset] ?? 0,
      data[recordOffset + 1] ?? 0,
      data[recordOffset + 2] ?? 0,
      data[recordOffset + 3] ?? 0,
    );
    const tableOffset = view.getUint32(recordOffset + 8);
    if (tag === 'OS/2') os2Offset = tableOffset;
    else if (tag === 'head') headOffset = tableOffset;
  }
  const weight = os2Offset !== null && os2Offset + 6 <= data.length
    ? view.getUint16(os2Offset + 4)
    : undefined;
  const macStyle = headOffset !== null && headOffset + 46 <= data.length
    ? view.getUint16(headOffset + 44)
    : undefined;
  return weight === undefined && macStyle === undefined ? null : { weight, macStyle };
}

/** Read weight/slant straight from an embedded sfnt (TrueType/OpenType) font program. */
export function fontStyleFromProgram(
  data: Uint8Array | undefined,
): { readonly bold: boolean; readonly italic: boolean } | null {
  const metadata = sfntStyleMetadata(data);
  if (!metadata) return null;
  return {
    bold: (metadata.weight ?? 0) >= 700 || ((metadata.macStyle ?? 0) & 0x1) !== 0,
    italic: ((metadata.macStyle ?? 0) & 0x2) !== 0,
  };
}

/** Resolve intrinsic bold without letting sanitized 400-weight metadata erase a named bold face. */
export function sourceBoldFromFont(
  fontName: string,
  data: Uint8Array | undefined,
): boolean {
  const namedBold = classifyFontStyle(fontName).bold;
  const metadata = sfntStyleMetadata(data);
  if (!metadata) return namedBold;
  if (((metadata.macStyle ?? 0) & 0x1) !== 0) return true;
  if (metadata.weight !== undefined && metadata.weight >= 600 && metadata.weight < 700) {
    return false;
  }
  return (metadata.weight ?? 0) >= 700 || namedBold;
}

function boundingBox(points: readonly PdfPt[]): PdfRect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };
}

/** Keep the topmost of identical text fragments drawn at effectively the same point. */
export function dropSameSpotCopies(runs: readonly TextRun[]): TextRun[] {
  return runs.filter((run, index) => {
    const text = run.text.trim();
    if (!text) return true;
    const tolerance = Math.max(0.5, 0.03 * run.style.fontSizePt);
    return !runs.slice(index + 1).some((later) => (
      later.pageIndex === run.pageIndex &&
      later.text.trim() === text &&
      Math.abs(later.style.fontSizePt - run.style.fontSizePt) <= 0.5 &&
      Math.abs(later.rect.x - run.rect.x) <= tolerance &&
      Math.abs(later.rect.y - run.rect.y) <= tolerance
    ));
  });
}

/** Text tilted further than this from straight or upright is a watermark or stamp. */
const SLANT_DEGREES = 5;
/** Text at least this many times the size of text written over it is a backdrop. */
const BACKDROP_SIZE_RATIO = 2;
/** The text on top must cover this share of the smaller of the two boxes. */
const BACKDROP_OVERLAP = 0.3;

/** Whether a text matrix runs at a slant rather than straight across or up and down. */
export function isSlantedText(transform: readonly number[]): boolean {
  const degrees = Math.abs(Math.atan2(transform[1] ?? 0, transform[0] ?? 0) * 180 / Math.PI) % 90;
  return Math.min(degrees, 90 - degrees) > SLANT_DEGREES;
}

function overlapArea(left: PdfRect, right: PdfRect): number {
  const width = Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Mark big text that smaller text is later written over (a page-wide label behind
 * the reading text) as background, so editing never mixes it into a paragraph.
 */
export function markBackdropText(
  runs: readonly TextRun[],
  paintedAt: ReadonlyMap<TextRun, number>,
): TextRun[] {
  const smallest = Math.min(...runs.map(run => run.style.fontSizePt));
  return runs.map((run) => {
    const at = paintedAt.get(run);
    if (run.background || at === undefined || run.style.fontSizePt < BACKDROP_SIZE_RATIO * smallest) return run;
    const behind = runs.some((over) => {
      const overAt = paintedAt.get(over);
      if (over.background || overAt === undefined || overAt <= at || !over.text.trim()) return false;
      if (run.style.fontSizePt < BACKDROP_SIZE_RATIO * over.style.fontSizePt) return false;
      const shared = overlapArea(run.rect, over.rect);
      return shared > 0 && shared >= BACKDROP_OVERLAP * Math.min(
        run.rect.w * run.rect.h,
        over.rect.w * over.rect.h,
      );
    });
    return behind ? { ...run, background: true } : run;
  });
}

/** Extract the text items for one page into the PDF-point space used by edits. */
export async function extractTextRuns(
  page: PDFPageProxy,
  pageIndex: number,
): Promise<TextRun[]> {
  const content = await page.getTextContent();
  // Hydrates font objects and gives us the paint order used to identify old
  // text concealed by a later opaque rectangle. pdf.js caches this per page.
  let operatorList: Awaited<ReturnType<typeof page.getOperatorList>> | null = null;
  try {
    operatorList = await page.getOperatorList();
  } catch {
    // A broken or unavailable operator list must not make readable text vanish.
    // The conservative fallback still removes exact same-spot copies.
  }
  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  const paintByItem = operatorList ? textPaintForItems(content.items, operatorList) : null;
  const glyphWidths = operatorList ? glyphWidthsByFont(operatorList) : new Map<string, Map<string, number>>();
  // Font identity is appearance metadata only: fontName and every grouping
  // decision stay unchanged. Only fonts actually used on this page are fetched.
  const usedRefs = [...new Set(content.items.flatMap(item => 'str' in item ? [item.fontName] : []))];
  for (const ref of usedRefs) if (page.commonObjs.has(ref)) registerSourceFont(ref, page.commonObjs.get(ref), glyphWidths.get(ref));
  await Promise.all(usedRefs.map(async ref => {
    if (!page.commonObjs.has(ref)) return;
    const font = page.commonObjs.get(ref);
    const style: TextStyle = { fontName: font?.name ?? ref, fontRef: ref, fontSizePt: 12,
      bold: sourceBoldFromFont(font?.name ?? ref, font?.data), italic: classifyFontStyle(font?.name ?? ref).italic,
      color: { r: 0, g: 0, b: 0 }, ...sourceFontIdentity(ref) };
    try {
      await prepareSourceFont(ref, style, usedRefs);
      await ensureMatchedFont({ ...style, ...sourceFontIdentity(ref) });
    } catch { /* Failed font loading must never hide readable source text. Export reports it. */ }
  }));
  const sourceStates = operatorList ? textStatesForItems(content.items, operatorList) : [];
  const wordSpacing = operatorList ? await rawSpacing(page) : new Map<string, RawSpacing>();
  const runs: TextRun[] = [];
  const itemIndexes: number[] = [];

  for (const [itemIndex, item] of content.items.entries()) {
    if (!('str' in item) || item.str.trim() === '' || item.width === 0) continue;
    const sourcePaint = paintByItem?.[itemIndex];
    if (sourcePaint && !sourcePaint.visible) continue;
    const isWordSymbolBullet = item.str.trim() === WORD_SYMBOL_BULLET;

    const matrix = transform(viewport.transform, item.transform);
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = matrix;
    const horizontalScale = Math.hypot(a, b);
    const verticalScale = Math.hypot(c, d);
    if (horizontalScale === 0 || verticalScale === 0) continue;
    const paint = sourcePaint ? resolveTextPaint(sourcePaint, verticalScale) : undefined;

    // PDF.js reports item width/height in device space. Divide by the matrix
    // scale before applying the matrix so those dimensions are not scaled twice.
    const localWidth = item.width / horizontalScale;
    const localHeight = item.height / verticalScale;
    const apply = (x: number, y: number): ViewportPt => ({
      x: a * x + c * y + e,
      y: b * x + d * y + f,
    });
    const corners = [
      apply(0, 0),
      apply(localWidth, 0),
      apply(0, localHeight),
      apply(localWidth, localHeight),
    ].map((point) => viewportToPdf(viewport, point));

    const fontRef = item.fontName;
    const fontName = content.styles[fontRef]?.fontFamily ?? fontRef;
    const fontObject = page.commonObjs.has(fontRef)
      ? page.commonObjs.get(fontRef)
      : undefined;
    if (fontObject) registerPdfJsFontReference(fontRef, fontObject);
    const weightSource = typeof fontObject?.name === 'string' && fontObject.name.trim() !== ''
      ? fontObject.name
      : fontName;
    const nameStyle = classifyFontStyle(weightSource);
    const fontData = fontObject?.data as Uint8Array | undefined;
    const programStyle = fontStyleFromProgram(fontData);
    const sourceBold = sourceBoldFromFont(weightSource, fontData);
    const paintBold = paint?.syntheticBold === true;
    const rect = boundingBox(corners);
    const advances = [...item.str].map((character) => glyphWidths.get(fontRef)?.get(character));
    const sum = advances.reduce<number>((total, width) => total + (width ?? NaN), 0);
    const characterWidthsPt = sum > 0 && Number.isFinite(sum)
      ? advances.map((width) => width! * rect.w / sum) : undefined;
    const spaceWidth = glyphWidths.get(fontRef)?.get(' ');
    const spaceWidthPt = characterWidthsPt && spaceWidth !== undefined && Number.isFinite(spaceWidth)
      ? spaceWidth * rect.w / sum : undefined;
    runs.push({
      pageIndex,
      // Word maps Symbol's 0xB7 bullet into this private-use character. It is
      // valid only with that embedded Symbol font, so normalize it before any
      // editor path can redraw it as an unknown-glyph box.
      text: isWordSymbolBullet ? STANDARD_BULLET : item.str,
      rect,
      metrics: sourceTextMetrics(item, content.styles[fontRef], sourceStates[itemIndex]),
      wordSpacing: wordSpacing.get(runKey(fontRef, item.str, item.transform[4]!, item.transform[5]!)),
      ...(characterWidthsPt ? { characterWidthsPt } : {}),
      ...(spaceWidthPt !== undefined ? { spaceWidthPt } : {}),
      ...(isSlantedText(item.transform) ? { background: true as const } : {}),
      style: {
        fontName,
        ...sourceFontIdentity(fontRef),
        fontSizePt: verticalScale,
        bold: sourceBold || paintBold,
        italic: nameStyle.italic || (programStyle?.italic ?? false),
        color: paint?.color ?? { r: 0, g: 0, b: 0 },
        sourceBold,
        ...(paintBold ? { sourceStrokeBold: true } : {}),
        ...(paint && !paint.supported ? { colorKnown: false } : {}),
        fontRef: isWordSymbolBullet ? undefined : fontRef,
      },
    });
    itemIndexes.push(itemIndex);
  }

  const visible = dropSameSpotCopies(operatorList
    ? dropCoveredTextRuns(runs, itemIndexes, content.items, operatorList, viewport)
    : runs);
  const operatorIndexes = operatorList ? mapTextItemsToOperators(content.items, operatorList) : null;
  const paintedAt = new Map<TextRun, number>();
  runs.forEach((run, index) => {
    const at = operatorIndexes?.[itemIndexes[index] ?? -1] ?? -1;
    if (at >= 0) paintedAt.set(run, at);
  });
  const marked = markBackdropText(visible, paintedAt);
  const tracking = pageFontTracking(marked);
  return marked.map(run => tracking.has(run.style.fontRef ?? '')
    ? { ...run, style: { ...run.style, fontTrackingEm: tracking.get(run.style.fontRef!)! } }
    : run);
}

/**
 * Resolve a PDF-point tap to the smallest containing run. If equal-area runs
 * overlap, the later item wins because it is topmost in PDF paint order.
 */
export function hitTestRun(
  runs: readonly TextRun[],
  point: PdfPt,
): TextRun | undefined {
  let match: TextRun | undefined;
  let matchArea = Number.POSITIVE_INFINITY;

  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (!run) continue;

    const { x, y, w, h } = run.rect;
    const contains =
      point.x >= x &&
      point.x <= x + w &&
      point.y >= y &&
      point.y <= y + h;
    const area = w * h;

    if (contains && area < matchArea) {
      match = run;
      matchArea = area;
    }
  }

  return match;
}
