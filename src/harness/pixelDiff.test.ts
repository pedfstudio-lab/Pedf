import { describe, expect, it } from 'vitest';
import pixelmatch from 'pixelmatch';

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
