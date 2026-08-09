import type { PageViewport } from 'pdfjs-dist';
import { pdfRectToScreenRect } from '@/lib/export/coordinates';
import type { PdfRect } from '@/lib/export/types';

export const RICH_SAMPLE_SIZE = 48;
export const RICH_MIN_COLORS = 64;
export const RICH_MAX_DOMINANT_FRACTION = 0.6;
export const RASTER_TEXT_MIN_COLORS = 24;
export const RASTER_TEXT_MIN_EDGE_RATIO = 0.025;
export const RASTER_TEXT_MIN_DOMINANT_FRACTION = 0.55;
export const RASTER_TEXT_MAX_DOMINANT_FRACTION = 0.95;
export const RASTER_TEXT_MIN_AREA_FRACTION = 0.04;

const QUANTIZATION_SHIFT = 3;

export interface ImageRichness {
  readonly colorCount: number;
  readonly dominantFraction: number;
  readonly edgeRatio: number;
  readonly rasterTextPattern: boolean;
  readonly rich: boolean;
}

export interface SampledImageRichness extends ImageRichness {
  readonly areaFraction: number;
}

/** Count distinct RGB colours after reducing each channel from 8 bits to 5 bits. */
export function countQuantizedColors(pixels: ArrayLike<number>): number {
  const colors = new Set<number>();
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3] ?? 0;
    if (alpha === 0) continue;
    const red = (pixels[offset] ?? 0) >> QUANTIZATION_SHIFT;
    const green = (pixels[offset + 1] ?? 0) >> QUANTIZATION_SHIFT;
    const blue = (pixels[offset + 2] ?? 0) >> QUANTIZATION_SHIFT;
    colors.add((red << 10) | (green << 5) | blue);
  }
  return colors.size;
}

export function classifyImageRichness(
  pixels: ArrayLike<number>,
  minimumColors = RICH_MIN_COLORS,
): ImageRichness {
  if (!Number.isFinite(minimumColors) || minimumColors < 1) {
    throw new RangeError('Rich-image colour threshold must be a positive finite number.');
  }
  const buckets = new Map<number, number>();
  const luminance: number[] = [];
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3] ?? 0;
    if (alpha === 0) continue;
    const red = pixels[offset] ?? 0;
    const green = pixels[offset + 1] ?? 0;
    const blue = pixels[offset + 2] ?? 0;
    const bucket = ((red >> QUANTIZATION_SHIFT) << 10) |
      ((green >> QUANTIZATION_SHIFT) << 5) |
      (blue >> QUANTIZATION_SHIFT);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    luminance.push(red * 0.2126 + green * 0.7152 + blue * 0.0722);
  }
  const colorCount = buckets.size;
  const dominant = Math.max(0, ...buckets.values());
  let edgeCount = 0;
  let edgePairs = 0;
  for (let index = 0; index < luminance.length; index += 1) {
    const x = index % RICH_SAMPLE_SIZE;
    const current = luminance[index] ?? 0;
    if (x > 0) {
      edgePairs += 1;
      if (Math.abs(current - (luminance[index - 1] ?? 0)) >= 32) edgeCount += 1;
    }
    if (index >= RICH_SAMPLE_SIZE) {
      edgePairs += 1;
      if (Math.abs(current - (luminance[index - RICH_SAMPLE_SIZE] ?? 0)) >= 32) edgeCount += 1;
    }
  }
  const dominantFraction = luminance.length > 0 ? dominant / luminance.length : 0;
  const edgeRatio = edgePairs > 0 ? edgeCount / edgePairs : 0;
  const rich = colorCount >= minimumColors &&
    dominantFraction < RICH_MAX_DOMINANT_FRACTION;
  return {
    colorCount,
    dominantFraction,
    edgeRatio,
    rasterTextPattern: !rich &&
      colorCount >= RASTER_TEXT_MIN_COLORS &&
      dominantFraction >= RASTER_TEXT_MIN_DOMINANT_FRACTION &&
      dominantFraction < RASTER_TEXT_MAX_DOMINANT_FRACTION &&
      edgeRatio >= RASTER_TEXT_MIN_EDGE_RATIO,
    rich,
  };
}

export function isRasterTextRegion(
  richness: SampledImageRichness,
  minimumAreaFraction = RASTER_TEXT_MIN_AREA_FRACTION,
): boolean {
  if (!Number.isFinite(minimumAreaFraction) || minimumAreaFraction < 0 || minimumAreaFraction > 1) {
    throw new RangeError('Raster-text area threshold must be between 0 and 1.');
  }
  return richness.rasterTextPattern && richness.areaFraction >= minimumAreaFraction;
}

export function shouldKeepImageRegion(
  rich: boolean,
  hasText: boolean,
  paragraph: boolean,
  rasterText = false,
): boolean {
  return !((!rich && (hasText || rasterText)) || paragraph);
}

/** Downsample one PDF-space region from the fully painted page canvas and classify its richness. */
export function sampleImageRichness(
  canvas: HTMLCanvasElement,
  viewport: PageViewport,
  rect: PdfRect,
): SampledImageRichness | undefined {
  const source = pdfRectToScreenRect(rect, viewport, 1);
  const left = Math.max(0, Math.floor(source.left));
  const top = Math.max(0, Math.floor(source.top));
  const right = Math.min(canvas.width, Math.ceil(source.left + source.width));
  const bottom = Math.min(canvas.height, Math.ceil(source.top + source.height));
  if (right <= left || bottom <= top) return undefined;
  const areaFraction = Math.min(
    1,
    (source.width * source.height) / (canvas.width * canvas.height),
  );

  const sample = document.createElement('canvas');
  sample.width = RICH_SAMPLE_SIZE;
  sample.height = RICH_SAMPLE_SIZE;
  const context = sample.getContext('2d', { willReadFrequently: true });
  if (!context) return undefined;

  try {
    context.drawImage(
      canvas,
      left,
      top,
      right - left,
      bottom - top,
      0,
      0,
      RICH_SAMPLE_SIZE,
      RICH_SAMPLE_SIZE,
    );
    return {
      ...classifyImageRichness(
        context.getImageData(0, 0, RICH_SAMPLE_SIZE, RICH_SAMPLE_SIZE).data,
      ),
      areaFraction,
    };
  } catch {
    return undefined;
  }
}
