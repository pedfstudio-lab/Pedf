import type { TextAlignment, TextComposition, TextSpan, TextStyle } from '@/lib/export/types';
import type { TextLine } from '@/lib/pdf/textContent';
import { horizontalText } from '@/lib/pdf/textMetrics';
import { effectiveTextSpanStyle } from './richText';
import { sameStyle } from './textEditSession';
import { isIndicRun } from '@/lib/export/scriptRouting';

export type CompositionResult = { readonly composition: TextComposition } | { readonly reason: string };
export type MeasurePiece = (text: string, style: TextStyle, source?: TextComposition['pieces'][number]) => number;

/** Text offsets come from the existing string; no space threshold or string rewrite. */
export function sourceLineComposition(line: TextLine, alignment: TextAlignment = line.align ?? 'left', left = line.alignLeftPt ?? line.rect.x, width = line.alignWidthPt ?? line.rect.w): TextComposition | undefined {
  let cursor = 0;
  const pieces: TextComposition['pieces'][number][] = [];
  for (const run of line.runs) {
    const text = run.text.trim(), start = line.text.indexOf(text, cursor);
    if (!text || !run.metrics || start < cursor || /\S/u.test(line.text.slice(cursor, start)) || run.text !== text) return undefined;
    pieces.push({ text, x: run.metrics.x, baselineY: run.metrics.baselineY, widthPt: run.metrics.widthPt, style: run.style, source: run.metrics, sourceRect: run.rect });
    cursor = start + text.length;
  }
  if (!pieces.length || /\S/u.test(line.text.slice(cursor))) return undefined;
  return { version: 1, text: line.text, pieces, style: line.style, alignment, alignmentLeftPt: left, alignmentWidthPt: width };
}

function compatibleStyle(left: TextStyle, right: TextStyle): boolean {
  // CSS size serialization can round the last binary digit. This tolerance is
  // for matching a style, never for rounding a stored coordinate or advance.
  return Math.abs(left.fontSizePt - right.fontSizePt) < 1e-8
    && sameStyle(left, { ...right, fontSizePt: left.fontSizePt }) && left.fontRef === right.fontRef;
}

export interface ComposeOptions {
  readonly dx?: number;
  readonly dy?: number;
  readonly spans?: readonly TextSpan[];
}

/**
 * Reproduce source origins. A local edit changes one piece's width; subsequent
 * pieces receive only that delta. The measured air is never inferred from spaces.
 */
export function composeTextLine(source: TextComposition | undefined, text: string, style: TextStyle, measure: MeasurePiece, options: ComposeOptions = {}): CompositionResult {
  if (!source) return { reason: 'source-metrics-unavailable' };
  if (isIndicRun(text)) return { reason: 'indic-path-a' };
  if (text.includes('\n')) return { reason: 'line-reflow' };
  if (Math.abs(source.style.fontSizePt - style.fontSizePt) >= 1e-8) return { reason: 'font-size-changed' };
  if (!compatibleStyle(source.style, style)) return { reason: 'style-or-font-changed' };
  if (source.pieces.some(piece => piece.source && !horizontalText(piece.source))) return { reason: 'unsupported-text-matrix' };
  if (source.pieces.some(piece => piece.source && !piece.source.glyphs && ((piece.source.characterSpacing ?? 0) !== 0 || (piece.source.wordSpacing ?? 0) !== 0))) return { reason: 'unmatched-run-spacing' };
  const offsets: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const piece of source.pieces) {
    const start = source.text.indexOf(piece.text, cursor);
    if (start < cursor || /\S/u.test(source.text.slice(cursor, start))) return { reason: 'piece-text-unmatched' };
    offsets.push({ start, end: start + piece.text.length }); cursor = start + piece.text.length;
  }
  let prefix = 0, suffix = 0;
  while (prefix < source.text.length && prefix < text.length && source.text[prefix] === text[prefix]) prefix++;
  while (suffix < source.text.length - prefix && suffix < text.length - prefix && source.text.at(-1 - suffix) === text.at(-1 - suffix)) suffix++;
  const unchanged = source.text === text;
  if (!unchanged && prefix === 0 && suffix === 0) return { reason: 'whole-line-retyped' };
  const changedIndex = unchanged ? -1 : offsets.findIndex(({ start, end }) => prefix >= start && source.text.length - suffix <= end);
  if (!unchanged && changedIndex < 0) return { reason: 'edit-crosses-piece-boundary' };
  const edited = source.pieces.map((piece, index) => index === changedIndex
    ? piece.text.slice(0, prefix - offsets[index]!.start) + text.slice(prefix, text.length - suffix) + piece.text.slice(source.text.length - suffix - offsets[index]!.start)
    : piece.text);
  // Separator mutations must not be misinterpreted as a new designer gap.
  let rebuilt = '', oldEnd = 0;
  offsets.forEach(({ start, end }, index) => { rebuilt += source.text.slice(oldEnd, start) + edited[index]!; oldEnd = end; });
  rebuilt += source.text.slice(oldEnd);
  if (rebuilt !== text) return { reason: 'separator-changed' };
  if (options.spans) {
    let offset = 0;
    const resolved = options.spans.map(span => { const start = offset; offset += span.text.length; return { start, end: offset, style: effectiveTextSpanStyle(style, span) }; });
    let shift = 0;
    for (const [index, piece] of source.pieces.entries()) {
      const start = offsets[index]!.start + shift, end = start + edited[index]!.length;
      if (resolved.some(span => span.start < end && span.end > start && !compatibleStyle(piece.style, span.style))) return { reason: 'inline-style-changed' };
      shift += edited[index]!.length - piece.text.length;
    }
  }
  const widths = source.pieces.map((piece, index) => index === changedIndex ? measure(edited[index]!, piece.style, piece) : piece.widthPt);
  if (widths.some(width => !Number.isFinite(width) || width < 0)) return { reason: 'invalid-piece-width' };
  const delta = widths.reduce((sum, width, index) => sum + width - source.pieces[index]!.widthPt, 0);
  const anchorShift = source.alignment === 'center' ? -delta / 2 : source.alignment === 'right' ? -delta : 0;
  let advanceDelta = 0;
  const pieces = source.pieces.map((piece, index) => {
    const result = { ...piece, text: edited[index]!, widthPt: widths[index]!, x: piece.x + advanceDelta + anchorShift + (options.dx ?? 0), baselineY: piece.baselineY + (options.dy ?? 0),
      ...(piece.sourceVisible !== undefined ? { sourceVisible: false } : {}),
      ...(index === changedIndex ? { source: undefined } : {}) };
    advanceDelta += widths[index]! - piece.widthPt;
    return result;
  }).filter(piece => piece.text.length > 0);
  return { composition: { ...source, text, pieces, alignmentLeftPt: source.alignmentLeftPt + (options.dx ?? 0) } };
}

export function compositionWidth(composition: TextComposition): number {
  if (!composition.pieces.length) return 0;
  return Math.max(...composition.pieces.map(piece => piece.x + piece.widthPt)) - Math.min(...composition.pieces.map(piece => piece.x));
}
