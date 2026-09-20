import { OPS } from 'pdfjs-dist';
import type { PageViewport } from 'pdfjs-dist';
import { viewportToPdf } from './coordinates';
import type { PdfRect } from './types';
import { mapTextItemsToOperators } from '@/lib/pdf/hiddenText';
import type { OperatorListLike } from '@/lib/pdf/images';
import type { ContentToken, GlyphRange, TextShowOperator } from './contentStream';
import { decodedStringBytes, textShowOperators } from './contentStream';

interface PdfJsGlyph {
  readonly originalCharCode: number;
  readonly unicode: string;
  readonly width: number;
  readonly vmetric?: unknown;
}

interface PdfTextOperator {
  readonly operatorListIndex: number;
  readonly glyphs: readonly PdfJsGlyph[];
  readonly fontSize: number;
  readonly charSpacing: number;
}

export interface StreamTextOperator extends TextShowOperator {
  readonly streamIndex: number;
}

interface LocatedOperator extends StreamTextOperator {
  readonly tokens: readonly ContentToken[];
}

export interface CoveredGlyphRewrite {
  readonly streamIndex: number;
  readonly operatorOrdinal: number;
  readonly glyphByteRanges: readonly GlyphRange[];
  readonly removedRanges: readonly GlyphRange[];
  readonly advanceThousandths: readonly number[];
}

export interface CoveredGlyphPlan {
  readonly skipped: boolean;
  readonly reason?: string;
  readonly removedItems: number;
  readonly rewrites: readonly CoveredGlyphRewrite[];
}

interface TextItemLike {
  readonly str: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
}

const TEXT_SHOW = new Set([
  OPS.showText,
  OPS.showSpacedText,
  OPS.nextLineShowText,
  OPS.nextLineSetSpacingShowText,
]);

function skipped(reason: string): CoveredGlyphPlan {
  return { skipped: true, reason, removedItems: 0, rewrites: [] };
}

function glyphsIn(value: unknown, output: PdfJsGlyph[] = []): PdfJsGlyph[] {
  if (Array.isArray(value)) {
    for (const entry of value) glyphsIn(entry, output);
  } else if (value && typeof value === 'object') {
    const glyph = value as Partial<PdfJsGlyph>;
    if (
      typeof glyph.originalCharCode === 'number' && Number.isInteger(glyph.originalCharCode) &&
      glyph.originalCharCode >= 0 && typeof glyph.unicode === 'string' &&
      typeof glyph.width === 'number' && Number.isFinite(glyph.width)
    ) output.push(glyph as PdfJsGlyph);
  }
  return output;
}

function pdfTextOperators(operatorList: OperatorListLike): PdfTextOperator[] {
  const operators: PdfTextOperator[] = [];
  const stack: Array<{ fontSize: number; charSpacing: number }> = [];
  let fontSize = 0;
  let charSpacing = 0;
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index] ?? -1;
    const rawArgs = operatorList.argsArray[index];
    const args: readonly unknown[] = Array.isArray(rawArgs) ? rawArgs : [];
    if (operation === OPS.save) stack.push({ fontSize, charSpacing });
    else if (operation === OPS.restore) {
      const restored = stack.pop();
      if (restored) ({ fontSize, charSpacing } = restored);
    } else if (operation === OPS.setFont) {
      const size = args[1];
      if (typeof size === 'number' && Number.isFinite(size)) fontSize = size;
    } else if (operation === OPS.setCharSpacing) {
      const spacing = args[0];
      if (typeof spacing === 'number' && Number.isFinite(spacing)) charSpacing = spacing;
    } else if (operation === OPS.nextLineSetSpacingShowText) {
      const spacing = args[1];
      if (typeof spacing === 'number' && Number.isFinite(spacing)) charSpacing = spacing;
    }
    if (TEXT_SHOW.has(operation)) {
      operators.push({
        operatorListIndex: index,
        glyphs: glyphsIn(args),
        fontSize,
        charSpacing,
      });
    }
  }
  return operators;
}

function multiply(
  left: readonly number[],
  right: readonly number[],
): [number, number, number, number, number, number] {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = left;
  const [g = 1, h = 0, i = 0, j = 1, k = 0, l = 0] = right;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}

function textItemRect(item: TextItemLike, viewport: PageViewport): PdfRect | null {
  const matrix = multiply(viewport.transform, item.transform);
  const [a, b, c, d, e, f] = matrix;
  const horizontalScale = Math.hypot(a, b);
  const verticalScale = Math.hypot(c, d);
  if (horizontalScale === 0 || verticalScale === 0) return null;
  const width = item.width / horizontalScale;
  const height = item.height / verticalScale;
  const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([x = 0, y = 0]) => (
    viewportToPdf(viewport, { x: a * x + c * y + e, y: b * x + d * y + f })
  ));
  const xs = corners.map(({ x }) => x);
  const ys = corners.map(({ y }) => y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const bottom = Math.min(...ys);
  const top = Math.max(...ys);
  if (right <= left || top <= bottom) return null;
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}

export function coveredFraction(rect: PdfRect, cover: PdfRect): number {
  if (rect.w <= 0 || rect.h <= 0) return 0;
  const width = Math.max(0, Math.min(rect.x + rect.w, cover.x + cover.w) - Math.max(rect.x, cover.x));
  const height = Math.max(0, Math.min(rect.y + rect.h, cover.y + cover.h) - Math.max(rect.y, cover.y));
  return (width * height) / (rect.w * rect.h);
}

export function itemIsCovered(rect: PdfRect, covers: readonly PdfRect[]): boolean {
  return covers.some((cover) => coveredFraction(rect, cover) >= 0.9);
}

function glyphByteRanges(operator: LocatedOperator, glyphs: readonly PdfJsGlyph[]): GlyphRange[] | null {
  const actual = operator.stringTokenIndexes.flatMap((tokenIndex) => (
    [...decodedStringBytes(operator.tokens[tokenIndex] as ContentToken)]
  ));
  for (let byteWidth = 1; byteWidth <= 4; byteWidth += 1) {
    const encoded: number[] = [];
    const ranges: GlyphRange[] = [];
    let valid = true;
    for (const glyph of glyphs) {
      if (glyph.originalCharCode >= 2 ** (byteWidth * 8)) {
        valid = false;
        break;
      }
      const start = encoded.length;
      for (let shift = (byteWidth - 1) * 8; shift >= 0; shift -= 8) {
        encoded.push((glyph.originalCharCode >> shift) & 0xff);
      }
      ranges.push({ start, end: encoded.length });
    }
    if (valid && encoded.length === actual.length && encoded.every((byte, index) => byte === actual[index])) {
      return ranges;
    }
  }
  return null;
}

function streamOperators(streams: readonly (readonly ContentToken[])[]): LocatedOperator[] {
  const output: LocatedOperator[] = [];
  for (const [streamIndex, tokens] of streams.entries()) {
    for (const operator of textShowOperators(tokens)) {
      output.push({ ...operator, streamIndex, tokens });
    }
  }
  return output;
}

function charactersFor(glyphs: readonly PdfJsGlyph[]): Array<{ character: string; glyphIndex: number }> {
  return glyphs.flatMap((glyph, glyphIndex) => [...glyph.unicode]
    .filter((character) => !/\s/u.test(character))
    .map((character) => ({ character, glyphIndex })));
}

function rangesFromIndexes(indexes: ReadonlySet<number>): GlyphRange[] {
  const sorted = [...indexes].sort((left, right) => left - right);
  const ranges: GlyphRange[] = [];
  for (const index of sorted) {
    const previous = ranges.at(-1);
    if (previous && previous.end === index) ranges[ranges.length - 1] = { start: previous.start, end: index + 1 };
    else ranges.push({ start: index, end: index + 1 });
  }
  return ranges;
}

/**
 * Build a conservative removal plan. Any mismatch skips the whole page so the
 * exporter can retain its old cover-only behaviour.
 */
export function planCoveredGlyphRemoval(
  items: readonly unknown[],
  operatorList: OperatorListLike,
  viewport: PageViewport,
  streams: readonly (readonly ContentToken[])[],
  covers: readonly PdfRect[],
): CoveredGlyphPlan {
  try {
    if (operatorList.fnArray.includes(OPS.paintFormXObjectBegin)) {
      return skipped('the page contains a Form XObject');
    }
    const contentItems = items.filter((item): item is TextItemLike => (
      item !== null && typeof item === 'object' && 'str' in item &&
      typeof (item as { str?: unknown }).str === 'string'
    ));
    if (contentItems.every((item) => item.str.trim() === '')) return skipped('the page has no text');

    const rawOperators = streamOperators(streams);
    const pdfOperators = pdfTextOperators(operatorList);
    if (rawOperators.length !== pdfOperators.length) {
      return skipped('the content-stream and PDF.js text-show counts differ');
    }
    const mapped = mapTextItemsToOperators(items, operatorList);
    if (!mapped || mapped.length !== items.length) return skipped('PDF.js text-item mapping failed');

    const byIndex = new Map(pdfOperators.map((operator, ordinal) => [
      operator.operatorListIndex,
      { operator, ordinal },
    ]));
    const byteRanges = new Map<number, GlyphRange[]>();
    for (let ordinal = 0; ordinal < pdfOperators.length; ordinal += 1) {
      const pdfOperator = pdfOperators[ordinal];
      const rawOperator = rawOperators[ordinal];
      if (!pdfOperator || !rawOperator || pdfOperator.glyphs.some((glyph) => glyph.vmetric !== undefined)) {
        return skipped('the page uses unsupported vertical or missing glyph data');
      }
      const ranges = glyphByteRanges(rawOperator, pdfOperator.glyphs);
      if (!ranges) return skipped('glyph codes do not match the content stream');
      byteRanges.set(ordinal, ranges);
    }

    const cursors = new Map<number, number>();
    const removedByOrdinal = new Map<number, Set<number>>();
    let removedItems = 0;
    for (const [itemIndex, item] of items.entries()) {
      if (!item || typeof item !== 'object' || !('str' in item)) continue;
      const text = (item as { str?: unknown }).str;
      if (typeof text !== 'string') continue;
      const significant = [...text].filter((character) => !/\s/u.test(character));
      if (significant.length === 0) continue;
      const mappedIndex = mapped[itemIndex] ?? -1;
      const located = byIndex.get(mappedIndex);
      if (!located) return skipped('a text item spans unsupported text-show operators');
      const glyphCharacters = charactersFor(located.operator.glyphs);
      let cursor = cursors.get(located.ordinal) ?? 0;
      const matchedGlyphs = new Set<number>();
      for (const character of significant) {
        const next = glyphCharacters[cursor++];
        if (!next || next.character !== character) {
          return skipped('a text item does not match its text-show glyphs');
        }
        matchedGlyphs.add(next.glyphIndex);
      }
      cursors.set(located.ordinal, cursor);
      const rect = textItemRect(item as TextItemLike, viewport);
      if (!rect || !itemIsCovered(rect, covers)) continue;
      const removed = removedByOrdinal.get(located.ordinal) ?? new Set<number>();
      for (const glyphIndex of matchedGlyphs) removed.add(glyphIndex);
      removedByOrdinal.set(located.ordinal, removed);
      removedItems += 1;
    }

    const rewrites: CoveredGlyphRewrite[] = [];
    for (const [ordinal, removed] of removedByOrdinal) {
      const pdfOperator = pdfOperators[ordinal];
      const rawOperator = rawOperators[ordinal];
      const ranges = byteRanges.get(ordinal);
      if (!pdfOperator || !rawOperator || !ranges || pdfOperator.fontSize === 0) {
        return skipped('text spacing information is incomplete');
      }
      const spacing = (pdfOperator.charSpacing / pdfOperator.fontSize) * 1000;
      const advances = pdfOperator.glyphs.map((glyph) => glyph.width + spacing);
      rewrites.push({
        streamIndex: rawOperator.streamIndex,
        operatorOrdinal: rawOperator.ordinal,
        glyphByteRanges: ranges,
        removedRanges: rangesFromIndexes(removed),
        advanceThousandths: advances,
      });
    }
    return { skipped: false, removedItems, rewrites };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return skipped(`the page content could not be parsed (${message})`);
  }
}
