import type { PageViewport } from 'pdfjs-dist';
import { pdfRectToScreenRect } from '@/lib/export/coordinates';
import { sampleDominantColor } from '@/lib/export/colorSample';
import type { PdfRect, Rgb } from '@/lib/export/types';

export interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

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
  if (!context || bands.length === 0) return { r: 1, g: 1, b: 1 };

  try {
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
    return sampleDominantColor(pixels);
  } catch {
    return { r: 1, g: 1, b: 1 };
  }
}
