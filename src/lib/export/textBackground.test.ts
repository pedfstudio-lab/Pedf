import { describe, expect, it } from 'vitest';
import { sampleCanvasTextBackground } from './inkExtent';

const WIDTH = 100;
const HEIGHT = 100;
const viewport = { convertToViewportPoint: (x: number, y: number) => [x, HEIGHT - y] };

function canvas(pixel: (x: number, y: number) => readonly [number, number, number, number]) {
  const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      pixels.set(pixel(x, y), (y * WIDTH + x) * 4);
    }
  }
  return {
    width: WIDTH,
    height: HEIGHT,
    read: (x: number, y: number, width: number, height: number) => {
      const result = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row += 1) {
        for (let column = 0; column < width; column += 1) {
          const source = ((y + row) * WIDTH + x + column) * 4;
          result.set(pixels.slice(source, source + 4), (row * width + column) * 4);
        }
      }
      return result;
    },
  };
}

const rect = { x: 20, y: 30, w: 60, h: 40 };

describe('sampleCanvasTextBackground', () => {
  it('keeps a photograph tone instead of sampling large white glyphs', () => {
    const reader = canvas((x, y) => (
      x >= 30 && x < 70 && y >= 40 && y < 60
        ? [255, 255, 255, 255]
        : [56, 88, 120, 255]
    ));
    expect(sampleCanvasTextBackground(reader, viewport, rect, { r: 1, g: 1, b: 1 }))
      .toEqual({ r: 56 / 255, g: 88 / 255, b: 120 / 255 });
  });

  it('keeps a white table cell despite black text and borders', () => {
    const reader = canvas((x, y) => (
      x === 20 || x === 79 || y === 30 || y === 69
      || (x >= 40 && x < 60 && y >= 45 && y < 55)
        ? [0, 0, 0, 255]
        : [255, 255, 255, 255]
    ));
    expect(sampleCanvasTextBackground(reader, viewport, rect, { r: 0, g: 0, b: 0 }))
      .toEqual({ r: 1, g: 1, b: 1 });
  });

  it('returns white on a plain white page', () => {
    const reader = canvas(() => [255, 255, 255, 255]);
    expect(sampleCanvasTextBackground(reader, viewport, rect)).toEqual({ r: 1, g: 1, b: 1 });
  });
});
