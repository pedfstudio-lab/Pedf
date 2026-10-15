import type { TextComposition, TextSpan, TextStyle } from '@/lib/export/types';
import type { MeasureTextSpan, WrappedTextLine } from './textLayout';
import { effectiveTextSpans, effectiveTextSpanStyle } from './richText';

/** One uniform contraction, never smaller than any source-measured minimum gap. */
export function minimumWordSpacing(spans: readonly TextSpan[], style: TextStyle, measure: MeasureTextSpan, minimumGapEm?: number): number {
  if (minimumGapEm === undefined || !spans.length) return 0;
  return Math.min(0, Math.max(...spans.map(span => {
    const resolved = effectiveTextSpanStyle(style, span);
    return minimumGapEm * resolved.fontSizePt - measure(' ', span);
  })));
}

export function justifiedComposition(line: WrappedTextLine, style: TextStyle, x: number, y: number, width: number, last: boolean, measure: MeasureTextSpan): TextComposition {
  const spans = effectiveTextSpans(line.text, style, line.spans);
  const words: TextSpan[][] = [], gaps: TextSpan[][] = [];
  let inGap = false;
  for (const span of spans) for (const text of span.text.match(/\s+|\S+/gu) ?? []) {
    if (/\s/u.test(text[0]!)) {
      if (!words.length) continue;
      if (!inGap) gaps.push([]);
      gaps.at(-1)!.push({ ...span, text }); inGap = true;
    } else {
      if (!words.length || inGap) words.push([]);
      words.at(-1)!.push({ ...span, text }); inGap = false;
    }
  }
  const gapWidths = gaps.slice(0, Math.max(0, words.length - 1)).map(gap => gap.reduce((sum, span) => sum + measure(span.text, span), 0));
  const wordWidths = words.map(word => word.reduce((sum, span) => sum + measure(span.text, span), 0));
  const normal = wordWidths.reduce((a, b) => a + b, 0) + gapWidths.reduce((a, b) => a + b, 0);
  const extra = !last && gapWidths.length ? (width - normal) / gapWidths.length : 0;
  let pen = x;
  const pieces = words.flatMap((word, index) => {
    const values = word.map(span => {
      const advance = measure(span.text, span), piece = { text: span.text, x: pen, baselineY: y, widthPt: advance, style: effectiveTextSpanStyle(style, span) };
      pen += advance; return piece;
    });
    if (index < gapWidths.length) pen += gapWidths[index]! + extra;
    return values;
  });
  return { version: 1, text: line.text, pieces, style, alignment: 'justify', alignmentLeftPt: x, alignmentWidthPt: width };
}
