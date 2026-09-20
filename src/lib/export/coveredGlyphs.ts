import { OPS } from 'pdfjs-dist';
import type { PageViewport } from 'pdfjs-dist';
import { viewportToPdf } from './coordinates';
import type { PdfRect } from './types';
import { mapTextItemsToOperators } from '@/lib/pdf/hiddenText';
import type { OperatorListLike } from '@/lib/pdf/images';
import type { ContentToken, GlyphRange, TextShowOperator } from './contentStream';
import { decodedStringBytes, nameValue, textShowOperators } from './contentStream';

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
  readonly wordSpacing: number;
}

/**
 * One content stream: a page stream, or a Form XObject the page (or another
 * form) stamps onto it. `form` resolves an XObject name to its own node so the
 * walk can follow text drawn inside a form, exactly as PDF.js expands it.
 */
export interface ContentStreamNode {
  readonly key: string;
  readonly tokens: readonly ContentToken[];
  form(name: string): ContentStreamNode | null;
}

export interface StreamTextOperator extends TextShowOperator {
  readonly streamKey: string;
}

interface LocatedOperator extends StreamTextOperator {
  readonly tokens: readonly ContentToken[];
}

export interface CoveredGlyphRewrite {
  readonly streamKey: string;
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
  const stack: Array<{ fontSize: number; charSpacing: number; wordSpacing: number }> = [];
  let fontSize = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  const numberArg = (value: unknown): number | null => (
    typeof value === 'number' && Number.isFinite(value) ? value : null
  );
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index] ?? -1;
    const rawArgs = operatorList.argsArray[index];
    const args: readonly unknown[] = Array.isArray(rawArgs) ? rawArgs : [];
    if (operation === OPS.save) stack.push({ fontSize, charSpacing, wordSpacing });
    else if (operation === OPS.restore) {
      const restored = stack.pop();
      if (restored) ({ fontSize, charSpacing, wordSpacing } = restored);
    } else if (operation === OPS.setFont) {
      const size = numberArg(args[1]);
      if (size !== null) fontSize = size;
    } else if (operation === OPS.setCharSpacing) {
      const spacing = numberArg(args[0]);
      if (spacing !== null) charSpacing = spacing;
    } else if (operation === OPS.setWordSpacing) {
      const spacing = numberArg(args[0]);
      if (spacing !== null) wordSpacing = spacing;
    } else if (operation === OPS.nextLineSetSpacingShowText) {
      // " sets word spacing then character spacing before showing the text.
      const word = numberArg(args[0]);
      const character = numberArg(args[1]);
      if (word !== null) wordSpacing = word;
      if (character !== null) charSpacing = character;
    }
    if (TEXT_SHOW.has(operation)) {
      operators.push({
        operatorListIndex: index,
        glyphs: glyphsIn(args),
        fontSize,
        charSpacing,
        wordSpacing,
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

interface GlyphBytes {
  readonly ranges: readonly GlyphRange[];
  readonly byteWidth: number;
}

function glyphByteRanges(operator: LocatedOperator, glyphs: readonly PdfJsGlyph[]): GlyphBytes | null {
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
      return { ranges, byteWidth };
    }
  }
  return null;
}

const MAX_FORM_DEPTH = 8;

interface StreamWalk {
  readonly operators: readonly LocatedOperator[];
  /** How often each stream is painted; a form stamped twice cannot be rewritten once. */
  readonly invocations: ReadonlyMap<string, number>;
}

function walkStream(
  node: ContentStreamNode,
  depth: number,
  path: ReadonlySet<string>,
  operators: LocatedOperator[],
  invocations: Map<string, number>,
): void {
  invocations.set(node.key, (invocations.get(node.key) ?? 0) + 1);
  const byTokenIndex = new Map(
    textShowOperators(node.tokens).map((operator) => [operator.operatorTokenIndex, operator]),
  );
  let lastName: string | null = null;
  for (let index = 0; index < node.tokens.length; index += 1) {
    const token = node.tokens[index];
    if (!token || token.kind === 'whitespace' || token.kind === 'comment') continue;
    const operator = byTokenIndex.get(index);
    if (operator) {
      operators.push({ ...operator, streamKey: node.key, tokens: node.tokens });
      lastName = null;
      continue;
    }
    if (token.kind === 'name') {
      lastName = nameValue(token);
      continue;
    }
    if (token.kind === 'word') {
      if (token.value === 'Do' && lastName) {
        const child = depth < MAX_FORM_DEPTH ? node.form(lastName) : null;
        // A form that paints itself would never terminate; leaving it unwalked
        // makes the operator counts differ, which skips the page.
        if (child && !path.has(child.key)) {
          walkStream(child, depth + 1, new Set([...path, child.key]), operators, invocations);
        }
      }
      lastName = null;
    }
  }
}

function streamOperators(roots: readonly ContentStreamNode[]): StreamWalk {
  const operators: LocatedOperator[] = [];
  const invocations = new Map<string, number>();
  for (const root of roots) walkStream(root, 0, new Set([root.key]), operators, invocations);
  return { operators, invocations };
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
  roots: readonly ContentStreamNode[],
  covers: readonly PdfRect[],
): CoveredGlyphPlan {
  try {
    const contentItems = items.filter((item): item is TextItemLike => (
      item !== null && typeof item === 'object' && 'str' in item &&
      typeof (item as { str?: unknown }).str === 'string'
    ));
    if (contentItems.every((item) => item.str.trim() === '')) return skipped('the page has no text');

    const walk = streamOperators(roots);
    const rawOperators = walk.operators;
    const pdfOperators = pdfTextOperators(operatorList);
    if (rawOperators.length !== pdfOperators.length) {
      return skipped('the content-stream and PDF.js text-show counts differ');
    }
    const mapped = mapTextItemsToOperators(items, operatorList);
    if (!mapped || mapped.length !== items.length) return skipped('PDF.js text-item mapping failed');

    const byteRanges = new Map<number, GlyphBytes>();
    for (let ordinal = 0; ordinal < pdfOperators.length; ordinal += 1) {
      const pdfOperator = pdfOperators[ordinal];
      const rawOperator = rawOperators[ordinal];
      if (!pdfOperator || !rawOperator || pdfOperator.glyphs.some((glyph) => glyph.vmetric !== undefined)) {
        return skipped('the page uses unsupported vertical or missing glyph data');
      }
      const glyphBytes = glyphByteRanges(rawOperator, pdfOperator.glyphs);
      if (!glyphBytes) return skipped('glyph codes do not match the content stream');
      byteRanges.set(ordinal, glyphBytes);
    }

    // One continuous glyph sequence in paint order: a single text item can span
    // more than one text-showing operator, so per-operator cursors drift.
    const glyphStream = pdfOperators.flatMap((operator, ordinal) => (
      charactersFor(operator.glyphs).map(({ character, glyphIndex }) => ({
        ordinal,
        glyphIndex,
        character,
      }))
    ));
    const removedByOrdinal = new Map<number, Set<number>>();
    let cursor = 0;
    let removedItems = 0;
    for (const item of items) {
      if (!item || typeof item !== 'object' || !('str' in item)) continue;
      const text = (item as { str?: unknown }).str;
      if (typeof text !== 'string') continue;
      const significant = [...text].filter((character) => !/\s/u.test(character));
      if (significant.length === 0) continue;
      const matched: Array<{ ordinal: number; glyphIndex: number }> = [];
      for (const character of significant) {
        const next = glyphStream[cursor];
        cursor += 1;
        if (!next || next.character !== character) {
          return skipped(
            `a text item does not match its text-show glyphs (${JSON.stringify(text.slice(0, 20))}`
            + ` expected ${JSON.stringify(character)}, found ${JSON.stringify(next?.character ?? null)})`,
          );
        }
        matched.push(next);
      }
      const rect = textItemRect(item as TextItemLike, viewport);
      if (!rect || !itemIsCovered(rect, covers)) continue;
      for (const { ordinal, glyphIndex } of matched) {
        const removed = removedByOrdinal.get(ordinal) ?? new Set<number>();
        removed.add(glyphIndex);
        removedByOrdinal.set(ordinal, removed);
      }
      removedItems += 1;
    }

    const rewrites: CoveredGlyphRewrite[] = [];
    for (const [ordinal, removed] of removedByOrdinal) {
      const pdfOperator = pdfOperators[ordinal];
      const rawOperator = rawOperators[ordinal];
      const glyphBytes = byteRanges.get(ordinal);
      if (!pdfOperator || !rawOperator || !glyphBytes || pdfOperator.fontSize === 0) {
        return skipped('text spacing information is incomplete');
      }
      // A form stamped twice would need two different results from one stream.
      if ((walk.invocations.get(rawOperator.streamKey) ?? 0) !== 1) {
        return skipped('a Form XObject is painted more than once on the page');
      }
      const characterSpacing = (pdfOperator.charSpacing / pdfOperator.fontSize) * 1000;
      const wordSpacing = (pdfOperator.wordSpacing / pdfOperator.fontSize) * 1000;
      // Word spacing applies to the single-byte code 32 only (PDF 32 9.3.3).
      const spaced = (glyph: PdfJsGlyph): boolean => (
        glyphBytes.byteWidth === 1 && glyph.originalCharCode === 32
      );
      if (
        pdfOperator.wordSpacing !== 0 &&
        glyphBytes.byteWidth > 1 &&
        [...removed].some((index) => pdfOperator.glyphs[index]?.originalCharCode === 32)
      ) return skipped('word spacing cannot be measured for multi-byte spaces');
      const advances = pdfOperator.glyphs.map((glyph) => (
        glyph.width + characterSpacing + (spaced(glyph) ? wordSpacing : 0)
      ));
      rewrites.push({
        streamKey: rawOperator.streamKey,
        operatorOrdinal: rawOperator.ordinal,
        glyphByteRanges: glyphBytes.ranges,
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
