import { notImplemented } from '@/lib/util/assert';
import type { Rgb } from './types';

/** Task 10 replaces this guard with dominant-color sampling from locked raster pixels. */
export function sampleDominantColor(pixels: Uint8ClampedArray): Rgb {
  void pixels;
  return notImplemented('locked-raster background sampling (Task 10)');
}
