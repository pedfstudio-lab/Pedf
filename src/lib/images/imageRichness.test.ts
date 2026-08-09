import { describe, expect, it } from 'vitest';
import {
  classifyImageRichness,
  countQuantizedColors,
  isRasterTextRegion,
  RICH_MIN_COLORS,
  RICH_SAMPLE_SIZE,
  shouldKeepImageRegion,
} from './imageRichness';

function pixels(fill: (x: number, y: number) => readonly [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(RICH_SAMPLE_SIZE * RICH_SAMPLE_SIZE * 4);
  for (let y = 0; y < RICH_SAMPLE_SIZE; y += 1) {
    for (let x = 0; x < RICH_SAMPLE_SIZE; x += 1) {
      const offset = (y * RICH_SAMPLE_SIZE + x) * 4;
      const [red, green, blue] = fill(x, y);
      data[offset] = red;
      data[offset + 1] = green;
      data[offset + 2] = blue;
      data[offset + 3] = 255;
    }
  }
  return data;
}

describe('image richness', () => {
  it('classifies a synthetic flat card with a second text colour as flat', () => {
    const flat = pixels((x, y) => (x + y) % 17 === 0
      ? [32, 40, 48]
      : [240, 224, 200]);
    expect(countQuantizedColors(flat)).toBe(2);
    expect(classifyImageRichness(flat)).toMatchObject({ colorCount: 2, rich: false });
  });

  it('classifies deterministic colour noise as rich', () => {
    const noise = pixels((x, y) => [
      (x * 5 + y * 3) % 256,
      (x * 11 + y * 7) % 256,
      (x * 17 + y * 13) % 256,
    ]);
    const result = classifyImageRichness(noise);
    expect(result.colorCount).toBeGreaterThan(RICH_MIN_COLORS);
    expect(result.rich).toBe(true);
  });

  it('recognises a dominant flat background with varied text-like edges', () => {
    const rasterText = pixels((x, y) => {
      if (x % 7 === 0 && y % 3 !== 0) {
        return [
          16 + ((x * 13 + y * 7) % 160),
          16 + ((x * 17 + y * 11) % 160),
          16 + ((x * 19 + y * 5) % 160),
        ];
      }
      return [240, 224, 200];
    });
    const result = classifyImageRichness(rasterText);
    expect(result.rich).toBe(false);
    expect(result.rasterTextPattern).toBe(true);
    expect(isRasterTextRegion({ ...result, areaFraction: 0.08 })).toBe(true);
    expect(isRasterTextRegion({ ...result, areaFraction: 0.02 })).toBe(false);
  });

  it('keeps images unless they are flat with text or carry a paragraph', () => {
    expect(shouldKeepImageRegion(true, false, false)).toBe(true);
    expect(shouldKeepImageRegion(true, true, false)).toBe(true);
    expect(shouldKeepImageRegion(false, false, false)).toBe(true);
    expect(shouldKeepImageRegion(false, true, false)).toBe(false);
    expect(shouldKeepImageRegion(false, false, false, true)).toBe(false);
    expect(shouldKeepImageRegion(true, true, true)).toBe(false);
  });
});
