import type { TextSpan, TextStyle } from '@/lib/export/types';
import { MAX_FONT_SIZE_PT, MIN_FONT_SIZE_PT } from './fontSize';

export interface ScalableTextBox {
  readonly style: TextStyle;
  readonly spans?: readonly TextSpan[];
  readonly width: number;
}

/** Both axes count equally: 10 screen pixels per point at 100% zoom. */
export function cornerDragFactor(dx: number, dy: number, startSizePt: number, zoom = 1): number {
  return 1 + (dx + dy) / (10 * Math.max(0.01, zoom) * startSizePt);
}

/** A single clamped factor: never clamp individual words and lose their proportions. */
export function scaleTextBox<T extends ScalableTextBox>(box: T, requestedFactor: number): T & { readonly factor: number } {
  const sizes = [box.style.fontSizePt, ...(box.spans ?? []).map(span => span.fontSizePt ?? box.style.fontSizePt)];
  const minimum = MIN_FONT_SIZE_PT / Math.min(...sizes);
  const maximum = MAX_FONT_SIZE_PT / Math.max(...sizes);
  const factor = Math.max(minimum, Math.min(maximum, Number.isFinite(requestedFactor) ? requestedFactor : 1));
  if (factor === 1) return { ...box, factor };
  return {
    ...box,
    factor,
    style: { ...box.style, fontSizePt: box.style.fontSizePt * factor },
    ...(box.spans ? { spans: box.spans.map(span => ({ ...span,
      ...(span.fontSizePt !== undefined ? { fontSizePt: span.fontSizePt * factor } : {}),
    })) } : {}),
  };
}
