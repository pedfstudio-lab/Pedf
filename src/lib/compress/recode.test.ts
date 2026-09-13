import { describe, expect, it, vi } from 'vitest';
import { recodeImage, resizeSoftMask, type DecodedImagePixels } from './recode';

const pixels: DecodedImagePixels = {
  data: Uint8ClampedArray.of(1, 2, 3, 0, 4, 5, 6, 128),
  width: 2,
  height: 1,
  originalBytes: 20_000,
};

describe('photo recoding', () => {
  it('forces alpha opaque and passes the requested target and quality', async () => {
    const encode = vi.fn(async (...args: [DecodedImagePixels, { width: number; height: number }, number]) => {
      void args;
      return new Uint8Array(8_000);
    });
    const result = await recodeImage(pixels, { width: 20, height: 10 }, 0.75, encode);
    expect(result).toHaveLength(8_000);
    expect(Array.from(encode.mock.calls[0]![0].data)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(encode).toHaveBeenCalledWith(expect.anything(), { width: 20, height: 10 }, 0.75);
  });

  it('rejects an encoding that is not at least 15% smaller', async () => {
    await expect(recodeImage(pixels, { width: 2, height: 1 }, 0.85, async () => new Uint8Array(17_001)))
      .resolves.toBeUndefined();
  });

  it('leaves a 20 KB image alone when the absolute saving is only 5 KB', async () => {
    const small = { ...pixels, originalBytes: 20 * 1024 };
    await expect(recodeImage(small, { width: 2, height: 1 }, 0.8,
      async () => new Uint8Array(15 * 1024))).resolves.toBeUndefined();
  });

  it('replaces a 30 KB image when it saves 21 KB', async () => {
    const useful = { ...pixels, originalBytes: 30 * 1024 };
    await expect(recodeImage(useful, { width: 2, height: 1 }, 0.8,
      async () => new Uint8Array(9 * 1024))).resolves.toHaveLength(9 * 1024);
  });

  it('resizes soft-mask luminance to the replacement dimensions', () => {
    const mask: DecodedImagePixels = {
      data: Uint8ClampedArray.of(
        0, 0, 0, 255, 100, 100, 100, 255,
        200, 200, 200, 255, 255, 255, 255, 255,
      ),
      width: 2,
      height: 2,
      originalBytes: 4,
    };
    expect(resizeSoftMask(mask, { width: 1, height: 1 })).toEqual(Uint8Array.of(139));
    expect(resizeSoftMask(mask, { width: 3, height: 2 })).toEqual(
      Uint8Array.of(0, 50, 100, 200, 228, 255),
    );
  });
});
