import type { PdfRect } from '@/lib/export/types';

const RECT_EPSILON_PT = 0.01;

/** True only when `cover` fully contains `region`, allowing tiny PDF-coordinate drift. */
export function isRegionCovered(cover: PdfRect, region: PdfRect): boolean {
  return (
    cover.x <= region.x + RECT_EPSILON_PT &&
    cover.y <= region.y + RECT_EPSILON_PT &&
    cover.x + cover.w >= region.x + region.w - RECT_EPSILON_PT &&
    cover.y + cover.h >= region.y + region.h - RECT_EPSILON_PT
  );
}
