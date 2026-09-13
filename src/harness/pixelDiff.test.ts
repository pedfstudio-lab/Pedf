import { describe, expect, it } from 'vitest';
import pixelmatch from 'pixelmatch';
import { worstBlockDiff } from './pixelDiff';

function image(width: number, height: number, value: (x: number, y: number) => number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    const channel = value(x, y);
    data.set([channel, channel, channel, 255], offset);
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

describe('pixelmatch harness dependency', () => {
  it('reports no mismatch for identical pixels', () => {
    const expected = new Uint8ClampedArray([20, 40, 60, 255]);
    const actual = expected.slice();
    const diff = new Uint8ClampedArray(4);

    expect(pixelmatch(expected, actual, diff, 1, 1, { threshold: 0.1 })).toBe(0);
  });

  it('detects a changed pixel', () => {
    const expected = new Uint8ClampedArray([0, 0, 0, 255]);
    const actual = new Uint8ClampedArray([255, 255, 255, 255]);
    const diff = new Uint8ClampedArray(4);

    expect(pixelmatch(expected, actual, diff, 1, 1, { threshold: 0.1 })).toBe(1);
  });
});

describe('worst block difference', () => {
  it('returns the mean error and changed-pixel percent from the worst local block', () => {
    const before = image(4, 2, () => 0);
    const after = image(4, 2, (x, y) => x < 2 ? 30 : x === 2 && y === 0 ? 10 : 0);
    expect(worstBlockDiff(before, after, 2)).toEqual({ meanError: 30, changedPercent: 100 });
  });

  it('reports zero for byte-identical signature pixels', () => {
    const signature = image(120, 40, (x, y) => (x + y) % 19 === 0 ? 0 : 255);
    expect(worstBlockDiff(signature, image(120, 40, (x, y) => (x + y) % 19 === 0 ? 0 : 255)))
      .toEqual({ meanError: 0, changedPercent: 0 });
  });
});
