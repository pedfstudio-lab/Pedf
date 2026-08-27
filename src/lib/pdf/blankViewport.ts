import type { PageViewport } from 'pdfjs-dist';

/** Build the coordinate-compatible viewport used by editable blank pages. */
export function createBlankViewport(
  widthPt: number,
  heightPt: number,
  scale: number,
): PageViewport {
  if (!Number.isFinite(widthPt) || widthPt <= 0) {
    throw new RangeError(`blank page width must be positive: ${widthPt}`);
  }
  if (!Number.isFinite(heightPt) || heightPt <= 0) {
    throw new RangeError(`blank page height must be positive: ${heightPt}`);
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError(`blank viewport scale must be positive: ${scale}`);
  }

  return {
    width: widthPt * scale,
    height: heightPt * scale,
    convertToViewportPoint: (x: number, y: number) => [x * scale, (heightPt - y) * scale],
    convertToPdfPoint: (x: number, y: number) => [x / scale, heightPt - y / scale],
  } as unknown as PageViewport;
}
