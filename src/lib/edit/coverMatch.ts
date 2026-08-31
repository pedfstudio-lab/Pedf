import type { PdfRect } from '@/lib/export/types';

const RECT_EPSILON = 0.01;

function sameRect(left: PdfRect, right: PdfRect): boolean {
  return (
    Math.abs(left.x - right.x) < RECT_EPSILON &&
    Math.abs(left.y - right.y) < RECT_EPSILON &&
    Math.abs(left.w - right.w) < RECT_EPSILON &&
    Math.abs(left.h - right.h) < RECT_EPSILON
  );
}

export function coversOriginalRect(cover: PdfRect, original: PdfRect): boolean {
  const sameHorizontalBounds = (
    Math.abs(cover.x - original.x) < RECT_EPSILON &&
    Math.abs(cover.w - original.w) < RECT_EPSILON
  );
  const coverTop = cover.y + cover.h;
  const originalTop = original.y + original.h;
  return sameRect(cover, original) || (
    sameHorizontalBounds &&
    cover.y <= original.y + RECT_EPSILON &&
    coverTop >= originalTop - RECT_EPSILON
  ) || (
    // Task 44 trims only the cover's top edge to the real glyph ink. It is
    // still the same source-line anchor as long as it overlaps that line and
    // retains the original horizontal bounds.
    sameHorizontalBounds &&
    cover.y <= original.y + RECT_EPSILON &&
    coverTop > original.y + RECT_EPSILON
  );
}
