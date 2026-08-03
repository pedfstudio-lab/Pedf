import type { Rgb } from './types';

export function sampleDominantColor(pixels: Uint8ClampedArray): Rgb {
  interface Bucket {
    count: number;
    r: number;
    g: number;
    b: number;
  }

  const buckets = new Map<number, Bucket>();
  let winner: Bucket | undefined;

  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const r = pixels[index] ?? 0;
    const g = pixels[index + 1] ?? 0;
    const b = pixels[index + 2] ?? 0;
    const alpha = pixels[index + 3] ?? 0;
    if (alpha < 128) continue;

    const key = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
    if (!winner || bucket.count > winner.count) winner = bucket;
  }

  if (!winner) return { r: 1, g: 1, b: 1 };
  return {
    r: winner.r / winner.count / 255,
    g: winner.g / winner.count / 255,
    b: winner.b / winner.count / 255,
  };
}
