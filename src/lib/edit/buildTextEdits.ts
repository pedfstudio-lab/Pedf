import type {
  CoverEdit,
  TextAlignment,
  TextEdit,
  TextSpan,
  TextStyle,
  TextParagraphLayout,
  TextComposition,
} from '@/lib/export/types';
import type { PdfRect } from '@/lib/export/types';
import type { TextRun } from '@/lib/pdf/textContent';
import type { TextBlock, TextLine } from '@/lib/pdf/textContent';
import type { BulletList } from '@/lib/pdf/bulletList';
import { formatBulletEditorText } from '@/lib/pdf/bulletList';
import { isArrowBullet, visibleBulletSymbol } from '@/lib/pdf/symbolBullets';
import type { WrappedTextLine } from './textLayout';
import { sourceParagraphLineHeight } from './paragraphSeed';
import { composeTextLine, compositionWidth, sourceLineComposition } from './lineComposition';
import type { MeasurePiece } from './lineComposition';
import { wrapTextParagraphs } from './paragraphLayout';
import { effectiveTextSpanStyle } from './richText';
import { justifiedComposition } from './justifiedLayout';
import { canUseSourceWord } from '@/lib/fonts/fontMatch';
import { locateFragments, overlapsFallback } from '@/lib/fonts/wordFonts';

let fallbackId = 0;

function id(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackId += 1;
  return `edit-${fallbackId}`;
}

function replacedText(runs: readonly TextRun[]) {
  return runs.map((run) => ({ text: run.text, rect: { ...run.rect } }));
}

export interface NextTextEdit {
  readonly text: string;
  readonly spans?: readonly TextSpan[];
  readonly paragraphs?: readonly TextParagraphLayout[];
  /** UI-only: untouched source paragraphs retain their displayed wraps. */
  readonly preserveSourceWrapping?: boolean;
  readonly style: TextStyle;
  readonly width: number;
  readonly height: number;
  readonly dx: number;
  readonly dy: number;
  readonly align?: TextAlignment;
  readonly alignLeftPt?: number;
  readonly alignWidthPt?: number;
  readonly boxLeftPt?: number;
  readonly boxWidthPt?: number;
  /** The editor font's ascent and descent as fractions of its size (paragraph mode). */
  readonly fontMetrics?: FontMetrics;
  /** Already-saved piece geometry on re-edit; no source reset after a move. */
  readonly sourceCompositions?: readonly (TextComposition | undefined)[];
  /** Glyph width measurement only, never a DOM position or line rectangle. */
  readonly measurePiece?: MeasurePiece;
  readonly sourceParagraphLines?: readonly (readonly WrappedTextLine[])[];
}

export interface FontMetrics {
  readonly ascent: number;
  readonly descent: number;
}

/** Arial/Helvetica, the editor's fallback face, when the real face was not measured. */
const DEFAULT_FONT_METRICS: FontMetrics = { ascent: 0.905, descent: 0.212 };

export function buildTextEdits(
  run: TextRun,
  next: NextTextEdit,
  z: number,
  base: PdfRect = run.rect,
): { readonly cover: CoverEdit; readonly text: TextEdit } {
  const cover: CoverEdit = {
    id: id(),
    kind: 'cover',
    pageIndex: run.pageIndex,
    rect: run.rect,
    z,
    sampleBackground: true,
    replaces: replacedText([run]),
  };
  const text: TextEdit = {
    id: id(),
    kind: 'text',
    pageIndex: run.pageIndex,
    rect: {
      x: base.x + next.dx,
      y: base.y + next.dy,
      w: next.width,
      h: base.h,
    },
    z: z + 1,
    text: next.text,
    style: next.style,
    ...(next.spans ? { spans: next.spans, boxSpans: next.spans } : {}),
    boxText: next.text,
    boxHeight: next.height,
  };

  return { cover, text };
}

export interface TextBlockBase {
  readonly x: number;
  readonly topBaselineY: number;
}

function paddedRect(rect: PdfRect, style: TextStyle): PdfRect {
  const horizontalPad = Math.max(0.75, style.fontSizePt * 0.08);
  const verticalPad = Math.max(1, style.fontSizePt * 0.14);
  return {
    x: rect.x - horizontalPad,
    y: rect.y - verticalPad,
    w: rect.w + horizontalPad * 2,
    h: rect.h + verticalPad * 2,
  };
}

export function coverRectForTextLine(line: TextLine): PdfRect {
  return paddedRect(line.rect, line.style);
}

export function coverRectsForTextBlock(block: TextBlock): readonly PdfRect[] {
  if (block.lines.length === 0) return [paddedRect(block.rect, block.style)];
  return block.lines.map(coverRectForTextLine);
}

export function coverRectForTextBlock(block: TextBlock): PdfRect {
  const rects = coverRectsForTextBlock(block);
  const left = Math.min(...rects.map((rect) => rect.x));
  const bottom = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const top = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}

const MIN_LINE_HEIGHT_RATIO = 1.0;
const MAX_LINE_HEIGHT_RATIO = 1.5;

export function textBlockLineHeight(block: TextBlock, style: TextStyle, paragraphs = false): number {
  const scale = style.fontSizePt / Math.max(1, block.style.fontSizePt);
  if (paragraphs) return Math.max(0.1, sourceParagraphLineHeight(block) * scale);
  const detected = block.lineHeightPt * scale;
  return Math.min(
    style.fontSizePt * MAX_LINE_HEIGHT_RATIO,
    Math.max(style.fontSizePt * MIN_LINE_HEIGHT_RATIO, detected),
  );
}

export function freeTextLineHeight(style: TextStyle): number {
  return style.fontSizePt * 1.2;
}

export function wrappedLineFontSize(
  line: string | WrappedTextLine,
  baseStyle: TextStyle,
): number {
  if (typeof line === 'string' || !line.spans || line.spans.length === 0) {
    return baseStyle.fontSizePt;
  }
  return Math.max(...line.spans.map((span) => span.fontSizePt ?? baseStyle.fontSizePt));
}

type LineStep = (upper: string | WrappedTextLine, lower: string | WrappedTextLine) => number;

function tallerLineStep(lineHeight: (line: string | WrappedTextLine) => number): LineStep {
  return (upper, lower) => Math.max(lineHeight(upper), lineHeight(lower));
}

function baselinesForLines(
  lines: readonly (string | WrappedTextLine)[],
  firstBaseline: number,
  step: LineStep,
): number[] {
  const baselines: number[] = [];
  let baseline = firstBaseline;
  lines.forEach((line, index) => {
    baselines.push(baseline);
    const next = lines[index + 1];
    if (next !== undefined) baseline -= step(line, next);
  });
  return baselines;
}

interface TextLinePosition {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

function wrappedText(line: string | WrappedTextLine): string {
  return typeof line === 'string' ? line : line.text;
}

function paragraphLayout(line: string | WrappedTextLine, next: NextTextEdit): TextParagraphLayout | undefined {
  return typeof line === 'string' || line.paragraphIndex === undefined ? undefined : next.paragraphs?.[line.paragraphIndex];
}
function paragraphGap(line: string | WrappedTextLine, next: NextTextEdit): number {
  return typeof line !== 'string' && line.paragraphStart && line.paragraphIndex ? paragraphLayout(line, next)?.gapBeforePt ?? 0 : 0;
}
function modelLineHeight(block: TextBlock, next: NextTextEdit, line: string | WrappedTextLine): number {
  return textBlockLineHeight(block, { ...next.style, fontSizePt: wrappedLineFontSize(line, next.style) });
}

/** Baseline to baseline distance from `upper` to `lower`, excluding any paragraph gap. */
function modelLineStep(block: TextBlock, next: NextTextEdit, upper: string | WrappedTextLine, lower: string | WrappedTextLine): number {
  if (!next.paragraphs) return Math.max(modelLineHeight(block, next, upper), modelLineHeight(block, next, lower));
  // The paragraph editor is a CSS block with a unitless line-height, so lay out
  // exactly as CSS does or Done moves the lines. Every size s on a line gets
  // that ratio's leading split evenly, leaving s*(ratio+k)/2 above the baseline
  // and s*(ratio-k)/2 below (k = ascent - descent). The block's own size is
  // always present (the strut), so uniform lines step by exactly the pitch.
  const base = next.style.fontSizePt;
  const ratio = textBlockLineHeight(block, next.style, true) / Math.max(0.1, base);
  const metrics = next.fontMetrics ?? DEFAULT_FONT_METRICS;
  const k = metrics.ascent - metrics.descent;
  const size = (line: string | WrappedTextLine) => Math.max(base, wrappedLineFontSize(line, next.style));
  const below = Math.max(base * (ratio - k), size(upper) * (ratio - k)) / 2;
  return below + size(lower) * (ratio + k) / 2;
}

/** A line where it is drawn now: the source line, or a saved edit's line. */
export interface PlacedTextLine {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

function sourcePlacedLines(block: TextBlock): PlacedTextLine[] {
  return block.lines.map((line) => ({ text: line.text, x: line.rect.x, y: line.baselineY, width: line.rect.w }));
}

function preservedTextLinePositions(
  block: TextBlock,
  next: NextTextEdit,
  wrappedLines: readonly (string | WrappedTextLine)[],
  fullPositions: readonly TextLinePosition[],
  // Unchanged lines stay where they are NOW: for a box edited (or moved) before,
  // that is its saved edit, not the source PDF. Measuring from the source made
  // every later move restart from the original spot and forget the earlier ones.
  current: readonly PlacedTextLine[],
): readonly TextLinePosition[] {
  if (current.length === 0 || wrappedLines.length === 0) return fullPositions;
  // A changed line count must reflow the following paragraphs, not strand them
  // at old baselines with an enlarged gap or overlapping new lines. Untouched
  // lines above the change stay where they are.
  const reflowTail = Boolean(next.paragraphs) && wrappedLines.length !== current.length;
  const nextTexts = wrappedLines.map(wrappedText);
  let prefixLength = 0;
  while (
    prefixLength < current.length
    && prefixLength < nextTexts.length
    && current[prefixLength]?.text === nextTexts[prefixLength]
  ) {
    prefixLength += 1;
  }
  if (reflowTail) return reflowedTextLinePositions(block, next, wrappedLines, fullPositions, prefixLength, current);

  let suffixLength = 0;
  while (
    suffixLength < current.length - prefixLength
    && suffixLength < nextTexts.length - prefixLength
    && current[current.length - 1 - suffixLength]?.text
      === nextTexts[nextTexts.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }
  if (prefixLength === 0 && suffixLength === 0 && !wrappedLines.some(line => typeof line !== 'string' && line.sourcePosition)) return fullPositions;

  const positions = fullPositions.map((position) => ({ ...position }));
  const preserve = (nextIndex: number, currentIndex: number) => {
    const placed = current[currentIndex];
    if (!placed) return;
    positions[nextIndex] = {
      x: placed.x + next.dx,
      y: placed.y + next.dy,
      width: placed.width,
    };
  };
  for (let index = 0; index < prefixLength; index += 1) preserve(index, index);
  for (let offset = 0; offset < suffixLength; offset += 1) {
    preserve(nextTexts.length - 1 - offset, current.length - 1 - offset);
  }
  wrappedLines.forEach((line, index) => {
    if (typeof line !== 'string' && line.sourcePosition) positions[index] = {
      x: line.sourcePosition.x + next.dx, y: line.sourcePosition.y + next.dy, width: line.sourcePosition.width,
    };
  });

  const middleEnd = nextTexts.length - suffixLength;
  for (let index = prefixLength; index < middleEnd; index += 1) {
    if (index === 0) continue;
    if (typeof wrappedLines[index] !== 'string' && (wrappedLines[index] as WrappedTextLine).sourcePosition) continue;
    const previous = wrappedLines[index - 1];
    const current = wrappedLines[index];
    const previousPosition = positions[index - 1];
    if (!previous || !current || !previousPosition) continue;
    positions[index] = {
      ...(positions[index] ?? { x: block.rect.x + next.dx, width: next.width }),
      y: previousPosition.y - modelLineStep(block, next, previous, current) - paragraphGap(current, next),
    };
  }
  return overlappingLines(next, wrappedLines, positions) ? fullPositions : positions;
}

/** Keep the unchanged leading lines in place; everything after them flows from the last one. */
function reflowedTextLinePositions(
  block: TextBlock,
  next: NextTextEdit,
  wrappedLines: readonly (string | WrappedTextLine)[],
  fullPositions: readonly TextLinePosition[],
  prefixLength: number,
  current: readonly PlacedTextLine[],
): readonly TextLinePosition[] {
  if (prefixLength === 0) return fullPositions;
  const positions = fullPositions.map((position) => ({ ...position }));
  for (let index = 0; index < prefixLength; index += 1) {
    const placed = current[index]!;
    positions[index] = { x: placed.x + next.dx, y: placed.y + next.dy, width: placed.width };
  }
  for (let index = prefixLength; index < wrappedLines.length; index += 1) {
    const previous = wrappedLines[index - 1]!, current = wrappedLines[index]!;
    positions[index] = {
      ...positions[index]!,
      y: positions[index - 1]!.y - modelLineStep(block, next, previous, current) - paragraphGap(current, next),
    };
  }
  return overlappingLines(next, wrappedLines, positions) ? fullPositions : positions;
}

function overlappingLines(
  next: NextTextEdit,
  wrappedLines: readonly (string | WrappedTextLine)[],
  positions: readonly TextLinePosition[],
): boolean {
  return positions.slice(1).some((lower, index) => {
    const upper = positions[index];
    const upperLine = wrappedLines[index];
    const lowerLine = wrappedLines[index + 1];
    if (!upper || !upperLine || !lowerLine) return false;
    const upperHeight = wrappedLineFontSize(upperLine, next.style);
    const lowerHeight = wrappedLineFontSize(lowerLine, next.style);
    const horizontalOverlap = Math.min(upper.x + upper.width, lower.x + lower.width)
      - Math.max(upper.x, lower.x);
    return horizontalOverlap > 0.01
      && lower.y + lowerHeight > upper.y + 0.01
      && upper.y + upperHeight > lower.y + 0.01;
  });
}

export function buildFreeTextEdits(
  pageIndex: number,
  rect: PdfRect,
  next: NextTextEdit,
  wrappedLines: readonly (string | WrappedTextLine)[],
  z: number,
  boxId = id(),
): readonly TextEdit[] {
  // The box's top is the top of the first font-size line box, not its PDF
  // baseline. Keeping that invariant makes Add Text agree before Done, after
  // Done, and after any number of re-opens.
  const firstBaseline = rect.y + rect.h - next.style.fontSizePt + next.dy;
  const baselines = baselinesForLines(
    wrappedLines,
    firstBaseline,
    tallerLineStep((line) => freeTextLineHeight({
      ...next.style,
      fontSizePt: wrappedLineFontSize(line, next.style),
    })),
  );
  return wrappedLines.map<TextEdit>((line, index) => {
    const text = typeof line === 'string' ? line : line.text;
    const spans = typeof line === 'string' ? undefined : line.spans;
    const fontSizePt = wrappedLineFontSize(line, next.style);
    return {
      id: id(),
      kind: 'text',
      pageIndex,
      rect: {
        x: rect.x + next.dx,
        y: baselines[index] ?? firstBaseline,
        w: next.width,
        h: fontSizePt,
      },
      z: z + index,
      text,
      style: next.style,
      origin: 'free',
      boxId,
      ...(spans && spans.length > 0 ? { spans } : {}),
      boxText: next.text,
      ...(next.spans ? { boxSpans: next.spans } : {}),
      boxHeight: next.height,
    };
  });
}

export function buildTextBlockEdits(
  block: TextBlock,
  next: NextTextEdit,
  wrappedLines: readonly (string | WrappedTextLine)[],
  z: number,
  base: TextBlockBase = { x: block.rect.x, topBaselineY: block.topBaselineY },
  /** The box's lines as saved now, when it was edited before; the source lines otherwise. */
  current: readonly PlacedTextLine[] = sourcePlacedLines(block),
): { readonly covers: readonly CoverEdit[]; readonly texts: readonly TextEdit[] } {
  const sources = next.sourceCompositions ?? block.lines.map(line => {
    const source = sourceLineComposition(line, block.align ?? 'left', block.alignLeftPt, block.alignWidthPt);
    return source ? { ...source, style: block.style } : undefined;
  });
  const measure = next.measurePiece ?? (() => NaN);
  if (next.align !== 'justify' && next.paragraphs && next.measurePiece) {
    const affected = new Set<number>();
    wrappedLines.forEach((line, index) => {
      const text = wrappedText(line), source = sources.length === wrappedLines.length ? sources[index] : sources.find(value => value?.text === text);
      const result = composeTextLine(source, text, next.style, measure, { spans: typeof line === 'string' ? undefined : line.spans });
      const layout = paragraphLayout(line, next), available = next.width - (typeof line !== 'string' && line.paragraphStart ? layout?.firstIndentPt ?? 0 : layout?.restIndentPt ?? 0);
      if ('composition' in result && compositionWidth(result.composition) > available + 0.5) affected.add(typeof line === 'string' ? 0 : line.paragraphIndex ?? 0);
    });
    if (affected.size) wrappedLines = wrapTextParagraphs(next, (text, span) => measure(text, effectiveTextSpanStyle(next.style, span)), block)
      .map(line => affected.has(line.paragraphIndex ?? 0) ? { ...line, sourcePosition: undefined, compositionFallback: 'piece-layout-exceeds-column' } : line);
  }
  let singleCompositionFallback: string | undefined;
  // The model may retain a matched single source line even when the substitute
  // typing face wrapped it. This does not alter native editable line breaking.
  if (sources.length === 1 && !next.paragraphs && !next.text.includes('\n')) {
    const result = composeTextLine(sources[0], next.text, next.style, measure, { spans: next.spans });
    if ('composition' in result && compositionWidth(result.composition) <= Math.min(next.width, next.alignWidthPt ?? block.alignWidthPt ?? next.width)) {
      wrappedLines = [{ text: next.text, ...(next.spans ? { spans: next.spans } : {}) }];
    } else singleCompositionFallback = 'reason' in result ? result.reason : 'piece-layout-exceeds-column';
  }
  const covers = coverRectsForTextBlock(block).map<CoverEdit>((rect, index) => {
    const runs = block.lines[index]?.runs ?? block.lines.flatMap((line) => line.runs);
    return {
      id: id(),
      kind: 'cover',
      pageIndex: block.pageIndex,
      rect,
      z: z + index,
      sampleBackground: true,
      replaces: replacedText(runs),
    };
  });
  const firstBaseline = base.topBaselineY + next.dy;
  const baselines = baselinesForLines(
    wrappedLines,
    firstBaseline,
    (upper, lower) => modelLineStep(block, next, upper, lower) + paragraphGap(lower, next),
  );
  const align = next.align ?? block.align ?? 'left';
  const usesAlignmentColumn = align === 'center' || align === 'right';
  const alignLeftPt = next.alignLeftPt ?? block.alignLeftPt ?? base.x;
  const alignWidthPt = next.alignWidthPt ?? block.alignWidthPt ?? next.width;
  const textLeft = usesAlignmentColumn ? alignLeftPt + next.dx : base.x + next.dx;
  const textWidth = usesAlignmentColumn ? alignWidthPt : next.width;
  const fullPositions = wrappedLines.map<TextLinePosition>((line, index) => ({
    x: textLeft + (typeof line !== 'string' && line.paragraphStart ? paragraphLayout(line, next)?.firstIndentPt ?? 0 : paragraphLayout(line, next)?.restIndentPt ?? 0),
    y: baselines[index] ?? firstBaseline,
    width: Math.max(1, textWidth - (typeof line !== 'string' && line.paragraphStart ? paragraphLayout(line, next)?.firstIndentPt ?? 0 : paragraphLayout(line, next)?.restIndentPt ?? 0)),
  }));
  const envelopeChangedAt = next.paragraphs && sources.length === wrappedLines.length ? wrappedLines.findIndex((line, index) => {
    const old = sources[index];
    return old && Math.abs(Math.max(old.style.fontSizePt, ...old.pieces.map(piece => piece.style.fontSizePt)) - Math.max(next.style.fontSizePt, wrappedLineFontSize(line, next.style))) > 1e-8;
  }) : -1;
  const positions = envelopeChangedAt >= 0 ? reflowedTextLinePositions(block, next, wrappedLines, fullPositions, envelopeChangedAt, current)
    : preservedTextLinePositions(block, next, wrappedLines, fullPositions, current);
  const paragraphHeight = next.paragraphs ? Math.max(next.height, ...positions.map((position, index) => (
    firstBaseline - position.y + wrappedLineFontSize(wrappedLines[index]!, next.style)
  ))) : next.height;
  const texts = wrappedLines.map<TextEdit>((line, index) => {
    const text = typeof line === 'string' ? line : line.text;
    const spans = typeof line === 'string' ? undefined : line.spans;
    const fontSizePt = wrappedLineFontSize(line, next.style);
    const position = positions[index] ?? fullPositions[index] ?? {
      x: textLeft,
      y: firstBaseline,
      width: textWidth,
    };
    const sourceIndex = sources.length === wrappedLines.length ? index : sources.findIndex(source => source?.text === text);
    const source = sources[sourceIndex];
    const placed = current[sourceIndex];
    const fixedPosition = placed && position.y === placed.y + next.dy
      || typeof line !== 'string' && line.sourcePosition && position.y === line.sourcePosition.y + next.dy;
    let composition = composeTextLine(source, text, next.style, measure, {
      dx: next.dx,
      // A successfully matched local edit on an existing line keeps that
      // line's raw baseline. Re-subtracting the pitch introduces a final-bit
      // drift even when the line count and font size did not change.
      dy: envelopeChangedAt < 0 && (sources.length === wrappedLines.length || fixedPosition) ? next.dy
        : position.y - (source?.pieces[0]?.baselineY ?? placed?.y ?? position.y),
      spans,
    });
    if (typeof line !== 'string' && line.compositionFallback) composition = { reason: line.compositionFallback };
    // Reflowing one row is not permission to redraw every row. A source row
    // with identical text/style and baseline keeps its original run geometry.
    const unchangedSourceLine = source?.text === text && 'composition' in composition
      && composition.composition.pieces.every(piece => piece.source
        && piece.x === piece.source.x && piece.baselineY === piece.source.baselineY);
    if (!unchangedSourceLine && align === 'justify' && typeof line !== 'string' && !line.sourcePosition && next.measurePiece) {
      const following = wrappedLines[index + 1];
      const last = !following || typeof following === 'string' || following.paragraphStart === true;
      composition = { composition: justifiedComposition(line, next.style, position.x, position.y, position.width, last,
        (text, span) => measure(text, effectiveTextSpanStyle(next.style, span))) };
    }
    if ('composition' in composition && compositionWidth(composition.composition) > position.width + 0.5) composition = { reason: 'piece-layout-exceeds-column' };
    return {
      id: id(),
      kind: 'text',
      pageIndex: block.pageIndex,
      rect: {
        x: position.x,
        y: 'composition' in composition ? composition.composition.pieces[0]?.baselineY ?? position.y : position.y,
        w: position.width,
        h: fontSizePt,
      },
      z: z + covers.length + index,
      text,
      style: next.style,
      ...('composition' in composition ? { composition: composition.composition } : { compositionFallback: singleCompositionFallback ?? composition.reason }),
      ...(spans && spans.length > 0 ? { spans } : {}),
      boxText: next.text,
      ...(next.spans ? { boxSpans: next.spans } : {}),
      boxHeight: paragraphHeight,
      ...(index === 0 && next.paragraphs ? { boxParagraphs: next.paragraphs } : {}),
      ...(next.boxLeftPt !== undefined ? { boxLeftPt: next.boxLeftPt } : {}),
      ...(next.boxWidthPt !== undefined ? { boxWidthPt: next.boxWidthPt } : {}),
      ...(usesAlignmentColumn || align === 'justify' ? {
        align,
        alignLeftPt: position.x,
        alignWidthPt: position.width,
      } : {}),
    };
  });

  if (next.measurePiece && texts.some(edit => edit.composition)) {
    const key = (text: string, rect: PdfRect) => JSON.stringify([text, rect.x, rect.y, rect.w, rect.h]);
    const redraw = new Set<string>();
    for (const edit of texts) if (edit.composition) {
      const fragments = locateFragments(edit.text, edit.composition.pieces);
      const changedWords = [...edit.text.matchAll(/\S+/gu)].flatMap(word => {
        const range = { start: word.index, end: word.index + word[0].length };
        return edit.composition!.pieces.some((piece, index) => !piece.source && piece.style.fontIdentity
          && overlapsFallback(fragments[index]!.start, piece.text.length, [range])
          && !canUseSourceWord(word[0], piece.style)) ? [range] : [];
      });
      edit.composition.pieces.forEach((piece, index) => {
        if (piece.sourceRect && overlapsFallback(fragments[index]!.start, piece.text.length, changedWords)) redraw.add(key(piece.text, piece.sourceRect));
      });
    }
    const stationary = new Set(texts.flatMap(edit => edit.composition?.pieces.flatMap(piece => piece.source && piece.sourceRect
      && piece.x === piece.source.x && piece.baselineY === piece.source.baselineY
      && !redraw.has(key(piece.text, piece.sourceRect))
      ? [key(piece.text, piece.sourceRect)] : []) ?? []));
    const dirtyRuns = block.lines.flatMap(line => line.runs).filter(run => !stationary.has(key(run.text, run.rect)));
    if (dirtyRuns.length && stationary.size) return {
      // Each existing line anchor owns the same explicit replacement intent.
      // The redactor already matches those named runs independently of patch
      // bounds. Keep all anchors/z slots, so re-edit/history ownership is unchanged.
      covers: covers.map(cover => ({ ...cover, replaces: replacedText(dirtyRuns) })),
      texts: texts.map(edit => edit.composition ? { ...edit, composition: { ...edit.composition,
        pieces: edit.composition.pieces.map(piece => ({ ...piece, sourceVisible: Boolean(piece.sourceRect && stationary.has(key(piece.text, piece.sourceRect))) })) } } : edit),
    };
  }
  return { covers, texts };
}

export interface BulletListItemLayout {
  readonly text: string;
  readonly lines: readonly (string | WrappedTextLine)[];
}

export interface BuiltBulletListEdits {
  readonly covers: readonly CoverEdit[];
  readonly texts: readonly TextEdit[];
  readonly usedHeightPt: number;
  readonly overflow: boolean;
}

export interface BulletListBase {
  readonly bulletX: number;
  readonly textX: number;
  readonly topBaselineY: number;
}

/**
 * Where a saved list sits now, read from its own edits: markers ("•", or "➢"
 * since Task 76) and body lines. Without it a moved list returns to its source
 * position on the next Done.
 */
export function savedBulletListBase(texts: readonly TextEdit[]): BulletListBase | undefined {
  const marker = (edit: TextEdit) => edit.text === '•' || isArrowBullet(edit.text);
  const body = texts.filter((edit) => !marker(edit) && edit.text !== '');
  const glyphs = texts.filter(marker);
  if (body.length === 0 || glyphs.length === 0) return undefined;
  return {
    bulletX: Math.min(...glyphs.map((edit) => edit.rect.x)),
    textX: Math.min(...body.map((edit) => edit.rect.x)),
    topBaselineY: Math.max(...body.map((edit) => edit.rect.y)),
  };
}

/** One sampled patch owns both the original text and its painted bullet strip. */
export function coverRectForBulletList(list: BulletList): PdfRect {
  const padding = Math.max(0.75, list.block.style.fontSizePt * 0.08);
  return {
    x: list.coverRect.x - padding,
    y: list.coverRect.y - padding,
    w: list.coverRect.w + padding * 2,
    h: list.coverRect.h + padding * 2,
  };
}

/** A "•" glyph's dot is ~this fraction of its font size, centred ~this fraction above the baseline. */
const BULLET_GLYPH_DOT_RATIO = 0.31;
const BULLET_GLYPH_DOT_RISE = 0.31;

/** Render a list entirely through the existing cover + text export seam. */
export function buildBulletListEdits(
  list: BulletList,
  next: NextTextEdit,
  items: readonly BulletListItemLayout[],
  z: number,
  availableHeightPt: number,
  base: BulletListBase = {
    bulletX: list.bulletX,
    textX: list.textX,
    topBaselineY: list.block.topBaselineY,
  },
): BuiltBulletListEdits {
  const spacingScale = next.style.fontSizePt / Math.max(1, list.block.style.fontSizePt);
  const itemSpacing = list.itemSpacingPt * spacingScale;
  const firstBaseline = base.topBaselineY + next.dy;
  let nextItemBaseline = firstBaseline;
  const itemLayouts = items.map((item, itemIndex) => {
    const lines = item.lines.length > 0 ? item.lines : [''];
    const lineHeight = (line: string | WrappedTextLine) => textBlockLineHeight(list.block, {
      ...next.style,
      fontSizePt: wrappedLineFontSize(line, next.style),
    });
    const baselines = baselinesForLines(lines, nextItemBaseline, tallerLineStep(lineHeight));
    const lastLine = lines.at(-1) ?? '';
    const lastBaseline = baselines.at(-1) ?? nextItemBaseline;
    nextItemBaseline = lastBaseline - lineHeight(lastLine);
    if (itemIndex < items.length - 1) nextItemBaseline -= itemSpacing;
    return { item, lines, baselines };
  });
  const lastBaseline = itemLayouts.at(-1)?.baselines.at(-1) ?? firstBaseline;
  const firstLine = itemLayouts[0]?.lines[0] ?? '';

  const usedHeightPt = items.length === 0
    ? 0
    : wrappedLineFontSize(firstLine, next.style) + firstBaseline - lastBaseline;
  // Room is measured from the list's original top; moving up (dy > 0) adds to it, as in the editor.
  if (usedHeightPt > availableHeightPt + next.dy + 0.5) {
    return { covers: [], texts: [], usedHeightPt, overflow: true };
  }

  const replacesImages = list.items.flatMap((item) => (
    item.markerImage ? [{ ...item.markerImage, rect: { ...item.markerImage.rect } }] : []
  ));
  const replacesShapes = list.items.flatMap(item => item.markerShape ? [{ rect: { ...item.markerShape.rect } }] : []);
  const cover: CoverEdit = {
    id: id(),
    kind: 'cover',
    pageIndex: list.block.pageIndex,
    rect: coverRectForBulletList(list),
    z,
    sampleBackground: true,
    replaces: replacedText(list.items.flatMap((item) => [
      ...(item.markerRun ? [item.markerRun] : []),
      ...item.lines.flatMap((line) => line.runs),
    ])),
    ...(replacesImages.length > 0 ? { replacesImages } : {}),
    ...(replacesShapes.length > 0 ? { replacesShapes } : {}),
  };
  const texts: TextEdit[] = [];
  const typedSymbols = next.text.split('\n').filter(line => line.trim()).map(line => {
    const character = [...line.trimStart()][0] ?? '';
    return character === '•' || isArrowBullet(character) ? visibleBulletSymbol(character) : undefined;
  });
  const symbols: string[] = [];
  items.forEach((_, index) => symbols.push(typedSymbols[index] ?? list.items[index]?.markerSymbol ?? symbols[index - 1] ?? '•'));
  const boxText = formatBulletEditorText(items.map((item) => item.text), symbols);
  const indent = Math.max(1, list.textX - list.bulletX);
  const textWidth = Math.max(1, next.width - indent);
  const bulletX = base.bulletX + next.dx;
  const textX = base.textX + next.dx;
  // Size the redrawn "•" to the measured original dot (bulletSizePt) rather than the
  // text size, and use a standard font — the "•" glyph isn't in the embedded subset.
  const bulletGlyphSizePt = list.bulletSizePt > 0
    ? Math.min(
        next.style.fontSizePt * 1.8,
        Math.max(next.style.fontSizePt * 0.75, list.bulletSizePt / BULLET_GLYPH_DOT_RATIO),
      )
    : next.style.fontSizePt;
  const bulletGlyphStyle: TextStyle = { ...next.style, fontSizePt: bulletGlyphSizePt, fontRef: undefined };
  const bulletGlyphDy = BULLET_GLYPH_DOT_RISE * (bulletGlyphSizePt - next.style.fontSizePt);
  // Retain a non-painting session anchor when every item is removed so the
  // now-empty list can still be reopened and edited without revealing source text.
  if (items.length === 0) {
    texts.push({
      id: id(),
      kind: 'text',
      pageIndex: list.block.pageIndex,
      rect: {
        x: bulletX,
        y: firstBaseline,
        w: next.width,
        h: next.style.fontSizePt,
      },
      z: z + 1,
      text: '',
      style: next.style,
      boxText: '',
      boxHeight: 0,
    });
  }

  for (const [itemIndex, { lines, baselines }] of itemLayouts.entries()) {
    const itemBaseline = baselines[0] ?? firstBaseline;
    const arrow = isArrowBullet(symbols[itemIndex]!);
    texts.push({
      id: id(),
      kind: 'text',
      pageIndex: list.block.pageIndex,
      rect: {
        x: bulletX,
        y: itemBaseline - (arrow ? 0 : bulletGlyphDy),
        w: next.width,
        h: arrow ? next.style.fontSizePt : bulletGlyphSizePt,
      },
      z: z + 1 + texts.length,
      text: symbols[itemIndex]!,
      style: arrow ? { ...bulletGlyphStyle, fontSizePt: next.style.fontSizePt } : bulletGlyphStyle,
      boxText,
      ...(next.spans ? { boxSpans: next.spans } : {}),
      boxHeight: usedHeightPt,
    });
    for (const [lineIndex, line] of lines.entries()) {
      const text = typeof line === 'string' ? line : line.text;
      const spans = typeof line === 'string' ? undefined : line.spans;
      const fontSizePt = wrappedLineFontSize(line, next.style);
      texts.push({
        id: id(),
        kind: 'text',
        pageIndex: list.block.pageIndex,
        rect: {
          x: textX,
          y: baselines[lineIndex] ?? itemBaseline,
          w: textWidth,
          h: fontSizePt,
        },
        z: z + 1 + texts.length,
        text,
        style: next.style,
        ...(spans && spans.length > 0 ? { spans } : {}),
        boxText,
        ...(next.spans ? { boxSpans: next.spans } : {}),
        boxHeight: usedHeightPt,
      });
    }
  }

  return { covers: [cover], texts, usedHeightPt, overflow: false };
}
