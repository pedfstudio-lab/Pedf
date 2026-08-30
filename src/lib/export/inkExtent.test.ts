import { describe, expect, it } from 'vitest';
import type { InkPixelReader, ViewportPointConverter } from './inkExtent';
import { expandRectForInk, measureCanvasInkExtent } from './inkExtent';

function makeReader(
  width: number,
  height: number,
  inkPixels: readonly (readonly [number, number, number?])[],
): InkPixelReader {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 255;
    pixels[offset + 1] = 255;
    pixels[offset + 2] = 255;
    pixels[offset + 3] = 255;
  }
  for (const [x, y, luminance = 0] of inkPixels) {
    const offset = (y * width + x) * 4;
    pixels[offset] = luminance;
    pixels[offset + 1] = luminance;
    pixels[offset + 2] = luminance;
  }

  return {
    width,
    height,
    read: (left, top, readWidth, readHeight) => {
      const data = new Uint8ClampedArray(readWidth * readHeight * 4);
      for (let y = 0; y < readHeight; y += 1) {
        for (let x = 0; x < readWidth; x += 1) {
          const source = ((top + y) * width + left + x) * 4;
          const target = (y * readWidth + x) * 4;
          data.set(pixels.subarray(source, source + 4), target);
        }
      }
      return data;
    },
  };
}

const uprightViewport: ViewportPointConverter = {
  convertToViewportPoint: (x, y) => [x, 20 - y],
};
const sourceRect = { x: 2, y: 8, w: 10, h: 4 };

describe('measureCanvasInkExtent', () => {
  it('counts a faded 235-luminance tip and adds the font-relative margin', () => {
    const reader = makeReader(20, 20, [
      [5, 12],
      [5, 13, 235],
    ]);

    const extent = measureCanvasInkExtent(reader, uprightViewport, sourceRect, 12);
    expect(extent.above).toBe(0);
    expect(extent.below).toBeCloseTo(2.6, 5);
  });

  it('stops at a clean white gap before ink from the next line', () => {
    const reader = makeReader(20, 20, [
      [5, 12],
      [5, 13],
      // Rows 14–15 are the inter-line gap; this later ink must not be included.
      [5, 16],
    ]);

    expect(measureCanvasInkExtent(reader, uprightViewport, sourceRect, 12).below)
      .toBeCloseTo(2.6, 5);
  });

  it('bridges one stray blank pixel inside a descender', () => {
    const reader = makeReader(20, 20, [
      [5, 12],
      // Row 13 is blank, but the fading tip continues on row 14.
      [5, 14, 235],
    ]);

    expect(measureCanvasInkExtent(reader, uprightViewport, sourceRect, 12).below)
      .toBeCloseTo(3.6, 5);
  });

  it('measures rare ink above the cover independently from descenders', () => {
    const reader = makeReader(20, 20, [
      [6, 7],
      [6, 6],
      [5, 12],
    ]);

    const extent = measureCanvasInkExtent(reader, uprightViewport, sourceRect, 12);
    expect(extent.above).toBeCloseTo(2.6, 5);
    expect(extent.below).toBeCloseTo(1.6, 5);
  });

  it('honors the hard scan cap even when ink continues', () => {
    const reader = makeReader(20, 20, [
      [5, 12],
      [5, 13],
      [5, 14],
      [5, 15],
    ]);

    // A 4pt font has a 2pt hard cap, including the safety margin.
    expect(measureCanvasInkExtent(reader, uprightViewport, sourceRect, 4).below).toBe(2);
  });

  it('follows the PDF vertical axis on rotated pages', () => {
    const rotatedViewport: ViewportPointConverter = {
      convertToViewportPoint: (x, y) => [20 - y, x],
    };
    const reader = makeReader(20, 20, [
      [12, 5],
      [13, 5],
      // Columns 14–15 are blank; later ink must not be included.
      [16, 5],
    ]);

    const extent = measureCanvasInkExtent(reader, rotatedViewport, sourceRect, 12);
    expect(extent.above).toBe(0);
    expect(extent.below).toBeCloseTo(2.6, 5);
  });

  it('does not add a margin when no ink is found', () => {
    expect(measureCanvasInkExtent(
      makeReader(20, 20, []),
      uprightViewport,
      sourceRect,
      12,
    )).toEqual({ above: 0, below: 0 });
  });

  it('falls back to no extension when canvas pixels cannot be read', () => {
    const reader: InkPixelReader = {
      width: 20,
      height: 20,
      read: () => {
        throw new Error('canvas unavailable');
      },
    };

    expect(measureCanvasInkExtent(reader, uprightViewport, sourceRect, 12)).toEqual({
      above: 0,
      below: 0,
    });
  });
});

describe('expandRectForInk', () => {
  it('preserves horizontal bounds while expanding above and below', () => {
    expect(expandRectForInk(sourceRect, { above: 1.5, below: 2.5 })).toEqual({
      x: 2,
      y: 5.5,
      w: 10,
      h: 8,
    });
  });
});
