import { describe, expect, it } from 'vitest';
import { sampleDominantColor } from './colorSample';

describe('sampleDominantColor', () => {
  it('selects the dominant quantized color instead of averaging noise', () => {
    const pixels = new Uint8ClampedArray([
      248, 250, 252, 255,
      251, 249, 250, 255,
      249, 251, 253, 255,
      40, 80, 220, 255,
    ]);

    const result = sampleDominantColor(pixels);
    expect(result.r).toBeGreaterThan(0.95);
    expect(result.g).toBeGreaterThan(0.95);
    expect(result.b).toBeGreaterThan(0.95);
  });

  it('falls back to white when no opaque pixels are present', () => {
    expect(sampleDominantColor(new Uint8ClampedArray([20, 30, 40, 0]))).toEqual({
      r: 1,
      g: 1,
      b: 1,
    });
  });
});
