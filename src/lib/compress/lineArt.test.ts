import { describe, expect, it } from 'vitest';
import type { CompressImageAnalysis } from './analyze';
import { isDocumentScan, isLineArt } from './lineArt';
import type { DecodedImagePixels } from './recode';

function image(overrides: Partial<CompressImageAnalysis> = {}): CompressImageAnalysis {
  return {
    id: 'image', width: 100, height: 100, filters: ['FlateDecode'], colorSpace: 'DeviceRGB',
    bitsPerComponent: 8, imageMask: false, hasSoftMask: false, hasMask: false,
    streamBytes: 20_000, drawnWidthPt: 100, drawnHeightPt: 100, shrinkable: true,
    ...overrides,
  };
}

function pixels(colours: readonly (readonly [number, number, number, number])[]): DecodedImagePixels {
  return {
    data: new Uint8ClampedArray(colours.flat()),
    width: colours.length,
    height: 1,
    originalBytes: 20_000,
  };
}

describe('line-art detection', () => {
  it('recognises a two-colour lossless image with an 8-bit soft mask', () => {
    expect(isLineArt(image({ hasSoftMask: true }), pixels([
      [0, 0, 0, 0], [255, 255, 255, 255],
    ]))).toBe(true);
  });

  it('does not mistake a smooth lossy photo with a mask for line art', () => {
    const smooth = Array.from({ length: 256 }, (_, index) =>
      [index, (index * 47) % 256, (index * 89) % 256, 64 + (index % 128)] as const);
    expect(isLineArt(image({ hasSoftMask: true, filters: ['DCTDecode'] }), pixels(smooth))).toBe(false);
  });

  it('recognises a greyscale scan without transparency', () => {
    const scan = Array.from({ length: 100 }, (_, index) =>
      index < 92 ? [248, 248, 248, 255] as const : [20, 20, 20, 255] as const);
    expect(isLineArt(image(), pixels(scan))).toBe(true);
  });

  it('recognises a screenshot with 20 flat colours dominated by four colours', () => {
    const dominant = Array.from({ length: 85 }, (_, index) => {
      const value = (index % 4) * 64;
      return [value, value, value, 255] as const;
    });
    const accents = Array.from({ length: 16 }, (_, index) =>
      [index * 7 + 1, index * 11 + 2, index * 13 + 3, 255] as const);
    expect(isLineArt(image({ filters: ['DCTDecode'] }), pixels([...dominant, ...accents]))).toBe(true);
  });
});

describe('document-scan detection', () => {
  it('recognises a JPEG-like paper gradient with dark printed text', () => {
    const scan = Array.from({ length: 2_000 }, (_, index) => {
      const text = index % 20 < 2;
      const noise = (index * 17) % 18;
      const value = text ? 18 + noise : 230 + noise;
      return [value + 2, value, value - 2, 255] as const;
    });
    expect(isDocumentScan(pixels(scan))).toBe(true);
  });

  it('rejects a colourful photo sitting on a white phone-screenshot canvas', () => {
    // 55% white margin + photo pixels with colour 80: averaged over every pixel that is only 36, which used to pass
    // as "little colour", and every pixel is a brightness extreme.
    const canvas = Array.from({ length: 1_000 }, (_, index) => {
      if (index % 20 < 11) return [255, 255, 255, 255] as const;
      return index % 2 ? [20, 100, 60, 255] as const : [255, 235, 175, 255] as const;
    });
    expect(isDocumentScan(pixels(canvas))).toBe(false);
  });

  it('still recognises a text screenshot on a white background', () => {
    const screenshot = Array.from({ length: 1_000 }, (_, index) => {
      const slot = index % 20;
      if (slot < 17) return [255, 255, 255, 255] as const;
      return slot < 19 ? [40, 40, 44, 255] as const : [150, 150, 152, 255] as const;
    });
    expect(isDocumentScan(pixels(screenshot))).toBe(true);
  });

  it('rejects a colour photo', () => {
    const photo = Array.from({ length: 512 }, (_, index) =>
      [index % 256, (index * 47) % 256, (index * 89) % 256, 255] as const);
    expect(isDocumentScan(pixels(photo))).toBe(false);
  });

  it('rejects a smooth black-and-white portrait with many mid-tones', () => {
    const portrait = Array.from({ length: 256 }, (_, value) => [value, value, value, 255] as const);
    expect(isDocumentScan(pixels(portrait))).toBe(false);
  });
});
