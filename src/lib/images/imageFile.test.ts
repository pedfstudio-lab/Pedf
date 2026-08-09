import { describe, expect, it } from 'vitest';
import { fitImageRect, imageMimeType, isJpg, isPng } from './imageFile';

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
});
