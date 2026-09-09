import { describe, expect, it } from 'vitest';
import { coverImageRect, fitImageRect, imageMimeType, isHeic, isJpg, isPng, isWebp } from './imageFile';

describe('image file helpers', () => {
  it('sniffs PNG and JPEG magic without trusting file extensions', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38]);

    expect(isPng(png)).toBe(true);
    expect(isJpg(png)).toBe(false);
    expect(imageMimeType(png)).toBe('image/png');
    expect(isJpg(jpg)).toBe(true);
    expect(imageMimeType(jpg)).toBe('image/jpeg');
    expect(imageMimeType(gif)).toBeUndefined();
  });

  it('sniffs WebP and HEIC container signatures', () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
    const heic = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    expect(isWebp(webp)).toBe(true);
    expect(imageMimeType(webp)).toBe('image/webp');
    expect(isHeic(heic)).toBe(true);
    expect(imageMimeType(heic)).toBeUndefined();
    const compatibleHeic = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31,
      0, 0, 0, 0, 0x68, 0x65, 0x69, 0x63, 0x6d, 0x69, 0x66, 0x31,
    ]);
    expect(isHeic(compatibleHeic)).toBe(true);
  });

  it('centers a landscape image inside a portrait target without stretching', () => {
    expect(fitImageRect({ x: 10, y: 20, w: 100, h: 100 }, 400, 200)).toEqual({
      x: 10,
      y: 45,
      w: 100,
      h: 50,
    });
  });

  it('centers a portrait image inside a landscape target without stretching', () => {
    expect(fitImageRect({ x: 10, y: 20, w: 120, h: 60 }, 100, 200)).toEqual({
      x: 55,
      y: 20,
      w: 30,
      h: 60,
    });
  });

  it('covers a wide box with a tall source by cropping the top and bottom', () => {
    const sourceRect = coverImageRect({ x: 10, y: 20, w: 120, h: 60 }, 100, 200);

    expect(sourceRect).toEqual({ x: 10, y: -70, w: 120, h: 240 });
    expect(sourceRect.w / sourceRect.h).toBe(100 / 200);
  });

  it('covers a tall box with a wide source by cropping the left and right', () => {
    const sourceRect = coverImageRect({ x: 10, y: 20, w: 60, h: 120 }, 200, 100);

    expect(sourceRect).toEqual({ x: -80, y: 20, w: 240, h: 120 });
    expect(sourceRect.w / sourceRect.h).toBe(200 / 100);
  });
});
