import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WATERMARK_OPTIONS,
  parseWatermarkOptions,
  WATERMARK_COLOURS,
  WATERMARK_FONTS,
  watermarkProblem,
} from './watermarkOptions';

describe('watermark options', () => {
  it('defaults every malformed choice and bounds numeric values', () => {
    expect(parseWatermarkOptions({ mode: 'video', font: 'comic', size: 99, colour: 'pink', angle: 12,
      position: 'somewhere', opacity: 'loud', imageScale: 9, pageSelection: 'some' }))
      .toEqual(DEFAULT_WATERMARK_OPTIONS);
  });

  it('keeps a dragged spot and falls back to the centre for out-of-page values', () => {
    expect(parseWatermarkOptions({ position: 'custom', customX: 0.2, customY: 0.9 }))
      .toMatchObject({ position: 'custom', customX: 0.2, customY: 0.9 });
    expect(parseWatermarkOptions({ position: 'custom', customX: 1.5, customY: -1 }))
      .toMatchObject({ position: 'custom', customX: 0.5, customY: 0.5 });
  });

  it('keeps valid image metadata and custom pages', () => {
    const bytes = new Uint8Array([1, 2]);
    expect(parseWatermarkOptions({ mode: 'image', imageBytes: bytes, imageMime: 'image/png', imageName: 'mark.png',
      imageWidth: 20, imageHeight: 10, imageScale: 0.25, opacity: 0.6, angle: -45,
      position: 'tile', pageSelection: 'custom', ranges: '2-4' })).toMatchObject({
      mode: 'image', imageBytes: bytes, imageMime: 'image/png', imageName: 'mark.png', imageWidth: 20,
      imageHeight: 10, imageScale: 0.25, opacity: 0.6, angle: -45, position: 'tile',
      pageSelection: 'custom', ranges: '2-4',
    });
  });

  it('returns the exact validation messages for empty, long, non-Latin and missing image values', () => {
    expect(watermarkProblem({ text: '   ' })).toBe('Type the watermark text first.');
    expect(watermarkProblem({ text: 'a'.repeat(101) })).toBe('Keep the watermark under 100 characters.');
    expect(watermarkProblem({ text: 'नमस्ते' })).toBe('Use English letters, numbers and common symbols for now.');
    expect(watermarkProblem({ text: 'Approved ✅' })).toBe('Use English letters, numbers and common symbols for now.');
    expect(watermarkProblem({ mode: 'image' })).toBe('Choose an image for the watermark first.');
    expect(watermarkProblem(DEFAULT_WATERMARK_OPTIONS)).toBeUndefined();
  });

  it('exposes the specified colour and standard-font tables', () => {
    expect(WATERMARK_COLOURS).toMatchObject({ grey: [0.5, 0.5, 0.5], black: [0, 0, 0], white: [1, 1, 1] });
    expect(WATERMARK_COLOURS.red.map((value) => Math.round(value * 255))).toEqual([0xd3, 0x2f, 0x2f]);
    expect(WATERMARK_COLOURS.blue.map((value) => Math.round(value * 255))).toEqual([0x1e, 0x6b, 0xff]);
    expect(WATERMARK_FONTS.sans.regular).toBe('Helvetica');
    expect(WATERMARK_FONTS.serif.bold).toBe('Times-Bold');
    expect(WATERMARK_FONTS.mono.bold).toBe('Courier-Bold');
  });
});
