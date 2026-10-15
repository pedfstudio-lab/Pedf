import type { TextSpan, TextStyle } from '@/lib/export/types';
import type { TextBlock } from '@/lib/pdf/textContent';
import type { NextTextEdit } from './buildTextEdits';
import { effectiveTextSpans, effectiveTextSpanStyle, normalizeTextSpans, sourceSpansForTextBlock, splitParagraphSpans } from './richText';
import { sourceParagraphs } from './paragraphSeed';
import { sameStyle } from './textEditSession';
import { wrapTextSpansToLines, type MeasureTextSpan, type WrappedTextLine } from './textLayout';
import { ZERO_PARAGRAPH } from './paragraphDom';
import { composeTextLine, compositionWidth, sourceLineComposition } from './lineComposition';
import { minimumWordSpacing } from './justifiedLayout';

function spanSlice(spans: readonly TextSpan[], start: number): TextSpan[] {
  let cursor = 0;
  return spans.flatMap(span => {
    const offset = Math.max(0, start - cursor); cursor += span.text.length;
    return offset < span.text.length ? [{ ...span, text: span.text.slice(offset) }] : [];
  });
}
function sameParagraphStyles(left: readonly TextSpan[], right: readonly TextSpan[], style: TextStyle): boolean {
  const canonical = (spans: readonly TextSpan[]) => normalizeTextSpans(spans.map(span => {
    const resolved = effectiveTextSpanStyle(style, span); return { text: span.text, ...resolved };
  }));
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Reflow each paragraph at its first/hanging widths, never across a hard boundary. */
export function wrapTextParagraphs(next: NextTextEdit, measure: MeasureTextSpan, source?: TextBlock): WrappedTextLine[] {
  const parts = splitParagraphSpans(effectiveTextSpans(next.text, next.style, next.spans));
  const original = source ? sourceParagraphs(source) : undefined;
  const originalSpans = original && source ? splitParagraphSpans(sourceSpansForTextBlock(source, original.text, true) ?? []) : [];
  return parts.flatMap<WrappedTextLine>((spans, paragraphIndex) => {
    const layout = next.paragraphs?.[paragraphIndex] ?? ZERO_PARAGRAPH;
    const text = spans.map(span => span.text).join('');
    const oldLines = original?.lines[paragraphIndex];
    const savedLines = next.sourceParagraphLines?.[paragraphIndex];
    if (savedLines?.length && sameStyle(source?.style ?? next.style, next.style)
      && savedLines.map(line => line.text).join(' ') === text
      && savedLines.every((line, index) => (line.sourcePosition?.width ?? 0) <= next.width - (index ? layout.restIndentPt : layout.firstIndentPt) + 0.5)
      && sameParagraphStyles(savedLines.flatMap((line, index) => {
        const values = effectiveTextSpans(line.text, next.style, line.spans);
        return [...values, ...(index < savedLines.length - 1 ? [{ ...(values.at(-1) ?? next.style), text: ' ' }] : [])];
      }), spans, next.style)) {
      return savedLines.map((line, index) => ({ ...line, paragraphIndex, paragraphStart: index === 0 }));
    }
    if (next.preserveSourceWrapping && source && original && oldLines?.length && parts.length === original.layouts.length
      && sameStyle(source.style, next.style) && original.text.split('\n')[paragraphIndex] === text
      && sameParagraphStyles(originalSpans[paragraphIndex] ?? [], spans, next.style)) {
      return oldLines.map((line, index) => ({ text: line.text,
        ...(next.spans ? { spans: sourceSpansForTextBlock({ ...source, text: line.text, lines: [line] }, line.text, true) } : {}),
        paragraphIndex, paragraphStart: index === 0,
        sourcePosition: { x: line.rect.x, y: line.baselineY, width: line.rect.w } }));
    }
    const firstWidth = Math.max(1, next.width - layout.firstIndentPt), restWidth = Math.max(1, next.width - layout.restIndentPt);
    const wrap = (widthMeasure: MeasureTextSpan) => {
      const first = wrapTextSpansToLines(spans, firstWidth, widthMeasure)[0] ?? { text: '' };
      const rest = text.slice(first.text.length), skip = rest.length - rest.trimStart().length;
      const tail = spanSlice(spans, first.text.length + skip);
      return [first, ...(tail.length ? wrapTextSpansToLines(tail, restWidth, widthMeasure) : [])];
    };
    const spacing = next.align === 'justify' ? minimumWordSpacing(spans, next.style, measure, layout.minimumWordGapEm) : 0;
    let lines = wrap(spacing ? (text, span) => measure(text, span) + (text.match(/\s/gu)?.length ?? 0) * spacing : measure), overflow = false;
    if (next.align === 'justify' && lines.length) {
      const last = lines.at(-1)!;
      const lastWidth = lines.length === 1 ? firstWidth : restWidth;
      if ((last.spans ?? []).reduce((sum, span) => sum + measure(span.text, span), 0) > lastWidth) {
        lines = [...lines.slice(0, -1), ...wrapTextSpansToLines(last.spans ?? [], lastWidth, measure)];
      }
    }
    const compositions = savedLines?.map(line => line.sourceComposition) ?? oldLines?.map(line => {
      const value = sourceLineComposition(line); return value && source ? { ...value, style: source.style } : value;
    });
    if (next.align !== 'justify' && next.measurePiece && compositions) {
      overflow = lines.some((line, index) => {
        const old = compositions[index];
        const result = composeTextLine(old, line.text, next.style, next.measurePiece!, { spans: line.spans });
        return old?.text !== line.text && 'composition' in result && compositionWidth(result.composition) > (index ? restWidth : firstWidth) + 0.5;
      });
      if (overflow) {
        const pieces = compositions.flatMap(composition => composition?.pieces ?? []);
        lines = wrap((value, span) => {
          const resolved = effectiveTextSpanStyle(next.style, span);
          const estimates = pieces.filter(piece => sameStyle(piece.style, resolved)).map(piece => next.measurePiece!(value, resolved, piece));
          return Math.max(measure(value, span), ...estimates.filter(Number.isFinite));
        });
      }
    }
    return lines.map((line, index) => ({ text: line.text, ...(next.spans && line.spans ? { spans: line.spans } : {}),
      paragraphIndex, paragraphStart: index === 0, ...(overflow ? { compositionFallback: 'piece-layout-exceeds-column' } : {}) }));
  });
}
