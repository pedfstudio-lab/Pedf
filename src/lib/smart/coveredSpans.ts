import type { PdfRect } from '@/lib/export/types';

interface PositionedSpan {
  readonly rect: PdfRect;
}

function overlapArea(left: PdfRect, right: PdfRect): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y),
  );
  return width * height;
}

export function filterCoveredSpans<T extends PositionedSpan>(
  spans: readonly T[],
  coverRects: readonly PdfRect[],
): T[] {
  return spans.filter((span) => {
    const area = span.rect.w * span.rect.h;
    if (!(area > 0)) return true;
    return !coverRects.some((cover) => overlapArea(span.rect, cover) / area >= 0.5);
  });
}
