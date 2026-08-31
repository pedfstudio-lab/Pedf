import type { PdfRect } from './types';

export interface InkExtent {
  readonly topTrim: number;
  readonly below: number;
}

export interface InkPixelReader {
  readonly width: number;
  readonly height: number;
  read(x: number, y: number, width: number, height: number): Uint8ClampedArray;
}

export interface ViewportPointConverter {
  convertToViewportPoint(x: number, y: number): ArrayLike<number>;
}

const NO_INK: InkExtent = { topTrim: 0, below: 0 };
const INK_LUMINANCE_THRESHOLD = 242;
const MIN_VISIBLE_ALPHA = 24;

function viewportPoint(
  viewport: ViewportPointConverter,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } | null {
  const point = viewport.convertToViewportPoint(x, y);
  const px = point[0];
  const py = point[1];
  return typeof px === 'number' && Number.isFinite(px) &&
    typeof py === 'number' && Number.isFinite(py)
    ? { x: px, y: py }
    : null;
}

function pixelIsInk(data: Uint8ClampedArray, offset: number): boolean {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  const alpha = data[offset + 3];
  if (red === undefined || green === undefined || blue === undefined || alpha === undefined) return false;
  if (alpha < MIN_VISIBLE_ALPHA) return false;
  const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  return luminance < INK_LUMINANCE_THRESHOLD;
}

function lineHasInk(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  axis: 'x' | 'y',
  position: number,
): boolean {
  if (axis === 'y') {
    if (position < 0 || position >= height) return false;
    for (let x = 0; x < width; x += 1) {
      if (pixelIsInk(data, (position * width + x) * 4)) return true;
    }
    return false;
  }

  if (position < 0 || position >= width) return false;
  for (let y = 0; y < height; y += 1) {
    if (pixelIsInk(data, (y * width + position) * 4)) return true;
  }
  return false;
}

function contiguousInkLines(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  axis: 'x' | 'y',
  start: number,
  step: -1 | 1,
  limit: number,
): number {
  let deepestInk = 0;
  let blankLines = 0;
  for (let offset = 0; offset < limit; offset += 1) {
    const position = start + offset * step;
    if (lineHasInk(data, width, height, axis, position)) {
      deepestInk = offset + 1;
      blankLines = 0;
      continue;
    }
    blankLines += 1;
    if (blankLines > 1) break;
  }
  return deepestInk;
}

function blankBandBeforeSubstantialInk(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  axis: 'x' | 'y',
  start: number,
  step: -1 | 1,
  limit: number,
  substantialInkPixels: number,
): number | null {
  let offset = 0;
  while (offset < limit) {
    const position = start + offset * step;
    if (!lineHasInk(data, width, height, axis, position)) {
      offset += 1;
      continue;
    }
    const bandPixels = contiguousInkLines(
      data,
      width,
      height,
      axis,
      position,
      step,
      limit - offset,
    );
    if (bandPixels >= substantialInkPixels) return offset;
    // This was a rule/underline-sized band. Move beyond it; the next loop
    // naturally skips its trailing blank gap before testing the next band.
    offset += Math.max(1, bandPixels);
  }
  return null;
}

/**
 * Measure the blank band inside the cover's top edge and contiguous source-page
 * ink immediately below its bottom edge. The top band lets the cover hug the
 * real glyphs; the below scan retains Task 41's half-font-size safety cap.
 */
export function measureCanvasInkExtent(
  reader: InkPixelReader,
  viewport: ViewportPointConverter,
  rect: PdfRect,
  fontSizePt: number,
): InkExtent {
  if (
    reader.width <= 0 || reader.height <= 0 || rect.w <= 0 || rect.h <= 0 ||
    !Number.isFinite(fontSizePt) || fontSizePt <= 0
  ) return NO_INK;

  const maxDistancePt = fontSizePt * 0.5;
  const marginPt = Math.max(0.5, fontSizePt * 0.05);

  const bottomLeft = viewportPoint(viewport, rect.x, rect.y);
  const topRight = viewportPoint(viewport, rect.x + rect.w, rect.y + rect.h);
  const origin = viewportPoint(viewport, rect.x, rect.y);
  const pdfUp = viewportPoint(viewport, rect.x, rect.y + 1);
  if (!bottomLeft || !topRight || !origin || !pdfUp) return NO_INK;

  const upX = pdfUp.x - origin.x;
  const upY = pdfUp.y - origin.y;
  const axis: 'x' | 'y' = Math.abs(upX) > Math.abs(upY) ? 'x' : 'y';
  const upDelta = axis === 'x' ? upX : upY;
  const pixelsPerPoint = Math.abs(upDelta);
  if (!Number.isFinite(pixelsPerPoint) || pixelsPerPoint <= 0) return NO_INK;

  const maxPixels = Math.max(1, Math.ceil(maxDistancePt * pixelsPerPoint));
  const coverLeft = Math.max(0, Math.floor(Math.min(bottomLeft.x, topRight.x)));
  const coverTop = Math.max(0, Math.floor(Math.min(bottomLeft.y, topRight.y)));
  const coverRight = Math.min(reader.width, Math.ceil(Math.max(bottomLeft.x, topRight.x)));
  const coverBottom = Math.min(reader.height, Math.ceil(Math.max(bottomLeft.y, topRight.y)));
  if (coverRight <= coverLeft || coverBottom <= coverTop) return NO_INK;

  const scanLeft = axis === 'x' ? Math.max(0, coverLeft - maxPixels) : coverLeft;
  const scanTop = axis === 'y' ? Math.max(0, coverTop - maxPixels) : coverTop;
  const scanRight = axis === 'x' ? Math.min(reader.width, coverRight + maxPixels) : coverRight;
  const scanBottom = axis === 'y' ? Math.min(reader.height, coverBottom + maxPixels) : coverBottom;
  const scanWidth = scanRight - scanLeft;
  const scanHeight = scanBottom - scanTop;
  if (scanWidth <= 0 || scanHeight <= 0) return NO_INK;

  let data: Uint8ClampedArray;
  try {
    data = reader.read(scanLeft, scanTop, scanWidth, scanHeight);
  } catch {
    return NO_INK;
  }
  if (data.length < scanWidth * scanHeight * 4) return NO_INK;

  const upStep: -1 | 1 = upDelta < 0 ? -1 : 1;
  const downStep: -1 | 1 = upStep === 1 ? -1 : 1;
  const minimum = axis === 'x' ? coverLeft - scanLeft : coverTop - scanTop;
  const maximum = axis === 'x' ? coverRight - scanLeft : coverBottom - scanTop;
  const topStart = downStep === 1 ? minimum : maximum - 1;
  const downStart = downStep === -1 ? minimum - 1 : maximum;
  const substantialInkPixels = Math.max(
    2,
    Math.ceil(fontSizePt * 0.2 * pixelsPerPoint),
  );
  const topBlankPixels = blankBandBeforeSubstantialInk(
    data,
    scanWidth,
    scanHeight,
    axis,
    topStart,
    downStep,
    maximum - minimum,
    substantialInkPixels,
  );
  const belowPixels = contiguousInkLines(
    data,
    scanWidth,
    scanHeight,
    axis,
    downStart,
    downStep,
    maxPixels,
  );

  const extentWithMargin = (pixels: number): number => pixels === 0
    ? 0
    : Math.min(maxDistancePt, pixels / pixelsPerPoint + marginPt);
  return {
    topTrim: topBlankPixels === null
      ? 0
      : Math.max(0, topBlankPixels / pixelsPerPoint - marginPt),
    below: extentWithMargin(belowPixels),
  };
}

export function expandRectForInk(rect: PdfRect, extent: InkExtent): PdfRect {
  if (extent.topTrim <= 0 && extent.below <= 0) return rect;
  const topTrim = Math.min(Math.max(0, extent.topTrim), rect.h);
  return {
    x: rect.x,
    y: rect.y - extent.below,
    w: rect.w,
    h: rect.h - topTrim + extent.below,
  };
}
