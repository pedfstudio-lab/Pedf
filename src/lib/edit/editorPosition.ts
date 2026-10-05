import type { PdfRect, TextEdit } from '@/lib/export/types';

/** Task 44's source-ink correction is needed only before a block has been saved. */
export function editorTopCorrection(hasSavedEdit: boolean, inkTopDelta: number): number {
  return hasSavedEdit ? 0 : inkTopDelta;
}

/**
 * CSS centers the font-size box inside a taller line-height box. Move the
 * editable content up by that half-leading so its first baseline matches the
 * line-height: 1 committed preview and the exported PDF.
 */
export function editorFirstLineOffsetPx(
  lineHeightPt: number,
  fontSizePt: number,
  zoom: number,
): number {
  const halfLeadingPx = Math.max(0, lineHeightPt - fontSizePt) * zoom / 2;
  return halfLeadingPx === 0 ? 0 : -halfLeadingPx;
}

/** Presentation only: align the measured CSS baseline with the commit baseline. */
export function baselineCorrectionPx(
  expectedBaselinePx: number | undefined,
  editorTopPx: number,
  measuredBaselineOffsetPx: number | undefined,
  fontSizePx: number,
): number {
  if (expectedBaselinePx === undefined || measuredBaselineOffsetPx === undefined
    || ![expectedBaselinePx, editorTopPx, measuredBaselineOffsetPx, fontSizePx].every(Number.isFinite)
    || fontSizePx <= 0) return 0;
  const difference = expectedBaselinePx - editorTopPx - measuredBaselineOffsetPx;
  return Math.max(-fontSizePx, Math.min(fontSizePx, difference));
}

/** Reconstruct an Add Text box without losing its first line's painted top. */
export function freeTextBoxRect(texts: readonly TextEdit[]): PdfRect {
  const first = texts[0];
  if (!first) return { x: 0, y: 0, w: 0, h: 0 };
  const height = first.boxHeight ?? first.style.fontSizePt * 1.2;
  const firstLineTop = first.rect.y + first.rect.h;
  return {
    x: first.rect.x,
    y: firstLineTop - height,
    w: first.rect.w,
    h: height,
  };
}
