import type { PageViewport } from 'pdfjs-dist';
import { pdfRectToScreenRect, screenRectToPdfRect } from '@/lib/export/coordinates';
import { sampleDominantColor } from '@/lib/export/colorSample';
import type { PdfRect, Rgb } from '@/lib/export/types';

export interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface DeleteCoverSample {
  readonly rect: PdfRect;
  readonly color: Rgb;
}

export interface DeleteCoverSampleOptions {
  readonly probeWidthPx?: number;
  readonly pageRingInnerPx?: number;
  readonly pageRingOuterPx?: number;
  readonly maxExpansionPx?: number;
}

const WHITE: Rgb = { r: 1, g: 1, b: 1 };
const FLAT_BUCKET_SHARE = 0.82;
const COLOR_MATCH_TOLERANCE = 20 / 255;
const PAGE_TRANSITION_SHARE = 0.4;

function clippedRect(
  left: number,
  top: number,
  width: number,
  height: number,
  canvasWidth: number,
  canvasHeight: number,
): PixelRect | undefined {
  const x1 = Math.max(0, Math.floor(left));
  const y1 = Math.max(0, Math.floor(top));
  const x2 = Math.min(canvasWidth, Math.ceil(left + width));
  const y2 = Math.min(canvasHeight, Math.ceil(top + height));
  if (x2 <= x1 || y2 <= y1) return undefined;
  return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
}

/** Four thin bands immediately outside a rendered image rectangle. */
export function outsideBandRects(
  target: PixelRect,
  canvasWidth: number,
  canvasHeight: number,
  margin: number,
): PixelRect[] {
  const candidates = [
    clippedRect(target.left - margin, target.top - margin, target.width + margin * 2, margin, canvasWidth, canvasHeight),
    clippedRect(target.left - margin, target.top + target.height, target.width + margin * 2, margin, canvasWidth, canvasHeight),
    clippedRect(target.left - margin, target.top, margin, target.height, canvasWidth, canvasHeight),
    clippedRect(target.left + target.width, target.top, margin, target.height, canvasWidth, canvasHeight),
  ];
  return candidates.filter((rect): rect is PixelRect => rect !== undefined);
}

function expandPixelRect(
  target: PixelRect,
  amount: number,
  canvasWidth: number,
  canvasHeight: number,
): PixelRect {
  const left = Math.max(0, target.left - amount);
  const top = Math.max(0, target.top - amount);
  const right = Math.min(canvasWidth, target.left + target.width + amount);
  const bottom = Math.min(canvasHeight, target.top + target.height + amount);
  return { left, top, width: right - left, height: bottom - top };
}

function outsideRingRects(
  target: PixelRect,
  canvasWidth: number,
  canvasHeight: number,
  inner: number,
  outer: number,
): PixelRect[] {
  const innerRect = expandPixelRect(target, inner, canvasWidth, canvasHeight);
  return outsideBandRects(
    innerRect,
    canvasWidth,
    canvasHeight,
    Math.max(1, outer - inner),
  );
}

function readBands(
  context: CanvasRenderingContext2D,
  bands: readonly PixelRect[],
): Uint8ClampedArray {
  const parts = bands.map((band) => context.getImageData(
    band.left,
    band.top,
    band.width,
    band.height,
  ).data);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const pixels = new Uint8ClampedArray(total);
  let offset = 0;
  for (const part of parts) {
    pixels.set(part, offset);
    offset += part.length;
  }
  return pixels;
}

function dominantBucketShare(pixels: Uint8ClampedArray): number {
  const buckets = new Map<number, number>();
  let opaqueCount = 0;
  let winnerCount = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3] ?? 0;
    if (alpha < 128) continue;
    const r = pixels[index] ?? 0;
    const g = pixels[index + 1] ?? 0;
    const b = pixels[index + 2] ?? 0;
    const key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
    const count = (buckets.get(key) ?? 0) + 1;
    buckets.set(key, count);
    opaqueCount += 1;
    winnerCount = Math.max(winnerCount, count);
  }
  return opaqueCount === 0 ? 0 : winnerCount / opaqueCount;
}

function colorsMatch(left: Rgb, right: Rgb): boolean {
  return (
    Math.abs(left.r - right.r) <= COLOR_MATCH_TOLERANCE &&
    Math.abs(left.g - right.g) <= COLOR_MATCH_TOLERANCE &&
    Math.abs(left.b - right.b) <= COLOR_MATCH_TOLERANCE
  );
}

function colorShare(pixels: Uint8ClampedArray, color: Rgb): number {
  const target = [color.r * 255, color.g * 255, color.b * 255] as const;
  const tolerance = COLOR_MATCH_TOLERANCE * 255;
  let opaqueCount = 0;
  let matchingCount = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = pixels[index + 3] ?? 0;
    if (alpha < 128) continue;
    opaqueCount += 1;
    if (
      Math.abs((pixels[index] ?? 0) - target[0]) <= tolerance &&
      Math.abs((pixels[index + 1] ?? 0) - target[1]) <= tolerance &&
      Math.abs((pixels[index + 2] ?? 0) - target[2]) <= tolerance
    ) {
      matchingCount += 1;
    }
  }
  return opaqueCount === 0 ? 0 : matchingCount / opaqueCount;
}

function samePixelRect(left: PixelRect, right: PixelRect): boolean {
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function sampleOutsideImage(
  canvas: HTMLCanvasElement,
  viewport: PageViewport,
  rect: PdfRect,
  marginPx = 5,
): Rgb {
  const screen = pdfRectToScreenRect(rect, viewport, 1);
  const bands = outsideBandRects(
    {
      left: screen.left,
      top: screen.top,
      width: screen.width,
      height: screen.height,
    },
    canvas.width,
    canvas.height,
    Math.max(1, marginPx),
  );
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context || bands.length === 0) return WHITE;

  try {
    return sampleDominantColor(readBands(context, bands));
  } catch {
    return WHITE;
  }
}

/**
 * Find the flat page color around a deletable image and absorb a differently-colored,
 * uniform card margin without ever expanding into a textured area.
 */
export function sampleDeleteImageCover(
  canvas: HTMLCanvasElement,
  viewport: PageViewport,
  rect: PdfRect,
  options: DeleteCoverSampleOptions = {},
): DeleteCoverSample {
  const probeWidth = Math.max(1, Math.round(options.probeWidthPx ?? 2));
  const pageRingInner = Math.max(probeWidth, Math.round(options.pageRingInnerPx ?? 24));
  const pageRingOuter = Math.max(pageRingInner + 1, Math.round(options.pageRingOuterPx ?? 40));
  const maxExpansion = Math.max(0, Math.round(options.maxExpansionPx ?? 40));
  const screen = pdfRectToScreenRect(rect, viewport, 1);
  const original = clippedRect(
    screen.left,
    screen.top,
    screen.width,
    screen.height,
    canvas.width,
    canvas.height,
  );
  if (!original) return { rect, color: WHITE };
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return { rect, color: WHITE };

  try {
    const immediateBands = outsideBandRects(
      original,
      canvas.width,
      canvas.height,
      probeWidth,
    );
    if (immediateBands.length === 0) return { rect, color: WHITE };
    const immediatePixels = readBands(context, immediateBands);
    const immediateColor = sampleDominantColor(immediatePixels);
    const pageBands = outsideRingRects(
      original,
      canvas.width,
      canvas.height,
      pageRingInner,
      pageRingOuter,
    );
    const pageColor = pageBands.length > 0
      ? sampleDominantColor(readBands(context, pageBands))
      : immediateColor;

    let current = original;
    let expansion = 0;
    let crossedFlatMargin = false;
    while (true) {
      const bands = outsideBandRects(
        current,
        canvas.width,
        canvas.height,
        probeWidth,
      );
      if (bands.length === 0) break;
      const pixels = readBands(context, bands);
      const color = sampleDominantColor(pixels);
      const pageReached = colorsMatch(color, pageColor) || (
        crossedFlatMargin && colorShare(pixels, pageColor) >= PAGE_TRANSITION_SHARE
      );
      if (pageReached) {
        return {
          rect: expansion === 0
            ? rect
            : screenRectToPdfRect(current, viewport, 1),
          color: pageColor,
        };
      }

      const flat = dominantBucketShare(pixels) >= FLAT_BUCKET_SHARE;
      if (!flat) {
        return {
          rect: expansion === 0
            ? rect
            : screenRectToPdfRect(current, viewport, 1),
          color: expansion === 0 ? color : pageColor,
        };
      }
      if (expansion >= maxExpansion) break;

      const amount = Math.min(probeWidth, maxExpansion - expansion);
      const expanded = expandPixelRect(current, amount, canvas.width, canvas.height);
      if (samePixelRect(expanded, current)) break;
      current = expanded;
      expansion += amount;
      crossedFlatMargin = true;
    }

    return {
      rect: expansion === 0 ? rect : screenRectToPdfRect(current, viewport, 1),
      color: pageColor,
    };
  } catch {
    return { rect, color: sampleOutsideImage(canvas, viewport, rect, probeWidth) };
  }
}
