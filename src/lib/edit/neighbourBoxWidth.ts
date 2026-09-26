import type { PdfRect, TextAlignment } from '@/lib/export/types';
import type { TextBlock } from '@/lib/pdf/textContent';

export interface NeighbourBoxGeometry {
  readonly pageIndex: number;
  readonly rect: PdfRect;
  readonly align: TextAlignment;
  readonly alignLeftPt: number;
  readonly alignWidthPt: number;
}

/** Limit only the editing box; the committed alignment region belongs to the block. */
export function neighbourBoxWidth(
  geometry: NeighbourBoxGeometry,
  blocks: readonly TextBlock[],
): { readonly left: number; readonly width: number } {
  const { x, y, w, h } = geometry.rect;
  if (geometry.align === 'left') return { left: x, width: w };

  const regionLeft = geometry.alignLeftPt;
  const regionRight = regionLeft + geometry.alignWidthPt;
  let left = regionLeft;
  let right = regionRight;
  for (const neighbour of blocks) {
    if (neighbour.pageIndex !== geometry.pageIndex) continue;
    const rect = neighbour.rect;
    const overlap = Math.min(y + h, rect.y + rect.h) - Math.max(y, rect.y);
    if (overlap <= Math.min(h, rect.h) / 2) continue;
    if (rect.x + rect.w <= x) left = Math.max(left, rect.x + rect.w);
    if (rect.x >= x + w) right = Math.min(right, rect.x);
  }
  left = Math.min(left, x);
  right = Math.max(right, x + w);
  return { left, width: right - left };
}
