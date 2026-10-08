import type { TextSpan, TextStyle } from '@/lib/export/types';
import type { TextBlock } from '@/lib/pdf/textContent';
import type { NextTextEdit } from './buildTextEdits';
import { effectiveTextSpans, effectiveTextSpanStyle, normalizeTextSpans, sourceSpansForTextBlock, splitParagraphSpans } from './richText';
import { sourceParagraphs } from './paragraphSeed';
import { sameStyle } from './textEditSession';
import { wrapTextSpansToLines, type MeasureTextSpan, type WrappedTextLine } from './textLayout';
import { ZERO_PARAGRAPH } from './paragraphDom';

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
  const original = source && next.preserveSourceWrapping ? sourceParagraphs(source) : undefined;
  const originalSpans = original && source ? splitParagraphSpans(sourceSpansForTextBlock(source, original.text, true) ?? []) : [];
  return parts.flatMap((spans, paragraphIndex) => {
    const layout = next.paragraphs?.[paragraphIndex] ?? ZERO_PARAGRAPH;
    const text = spans.map(span => span.text).join('');
    const oldLines = original?.lines[paragraphIndex];
    if (source && original && oldLines?.length && parts.length === original.layouts.length
      && sameStyle(source.style, next.style) && original.text.split('\n')[paragraphIndex] === text
      && sameParagraphStyles(originalSpans[paragraphIndex] ?? [], spans, next.style)) {
      return oldLines.map((line, index) => ({ text: line.text,
        ...(next.spans ? { spans: sourceSpansForTextBlock({ ...source, text: line.text, lines: [line] }, line.text, true) } : {}),
        paragraphIndex, paragraphStart: index === 0,
        sourcePosition: { x: line.rect.x, y: line.baselineY, width: line.rect.w } }));
    }
    const firstWidth = Math.max(1, next.width - layout.firstIndentPt), restWidth = Math.max(1, next.width - layout.restIndentPt);
    const first = wrapTextSpansToLines(spans, firstWidth, measure)[0] ?? { text: '' };
    const rest = text.slice(first.text.length), skip = rest.length - rest.trimStart().length;
    const tail = spanSlice(spans, first.text.length + skip);
    const lines = [first, ...(tail.length ? wrapTextSpansToLines(tail, restWidth, measure) : [])];
    return lines.map((line, index) => ({ text: line.text, ...(next.spans && line.spans ? { spans: line.spans } : {}),
      paragraphIndex, paragraphStart: index === 0 }));
  });
}
