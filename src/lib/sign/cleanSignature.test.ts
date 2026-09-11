// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cleanSignature, shrinkForCleaning, trimToInk } from './cleanSignature';

function image(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    data.set(paint(x, y), (y * width + x) * 4);
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

function visible(imageData: ImageData): number[] {
  const values: number[] = [];
  for (let offset = 3; offset < imageData.data.length; offset += 4) values.push(imageData.data[offset]!);
  return values;
}

describe('signature cleaning', () => {
  it('shrinks with area averaging, preserves proportions, and never enlarges', () => {
    const source = image(3200, 800, (x) => x === 1599 ? [0, 0, 255, 255] : [255, 255, 255, 255]);
    const result = shrinkForCleaning(source);
    expect([result.width, result.height]).toEqual([1600, 400]);
    const band = (200 * result.width + 799) * 4;
    expect(result.data[band]).toBeGreaterThan(0);
    expect(result.data[band]).toBeLessThan(255);
    expect(result.data[band + 2]).toBe(255);

    const small = image(640, 480, () => [255, 255, 255, 255]);
    expect(shrinkForCleaning(small)).toBe(small);
  });

  it('cleans a large ruled phone photo while preserving a crossing signature stroke', () => {
    const notebook = (withStroke: boolean) => image(3000, 2000, (x, y) => {
      if (withStroke && x >= 900 && x <= 2100 && Math.abs(y - (600 + (x - 900) / 6)) <= 8) return [8, 10, 14, 255];
      if (x >= 360 && x < 363) return [215, 112, 122, 255];
      if (y % 90 < 6) return [205, 225, 242, 255];
      const shadow = Math.round(246 - 20 * x / 2999);
      return [shadow, shadow - 8, shadow - 28, 255];
    });
    const options = { strength: 40, removeLines: true, ink: 'black' } as const;
    const linesOnly = cleanSignature(shrinkForCleaning(notebook(false)), options);
    const lineAlphas = visible(linesOnly);
    expect(lineAlphas.filter((alpha) => alpha > 240)).toHaveLength(0);

    const withStroke = cleanSignature(shrinkForCleaning(notebook(true)), options);
    const strokeOnly = cleanSignature(shrinkForCleaning(image(3000, 2000, (x, y) => {
      if (x >= 900 && x <= 2100 && Math.abs(y - (600 + (x - 900) / 6)) <= 8) return [8, 10, 14, 255];
      const shadow = Math.round(246 - 20 * x / 2999);
      return [shadow, shadow - 8, shadow - 28, 255];
    })), options);
    expect(visible(withStroke).some((alpha) => alpha > 220)).toBe(true);
    expect([withStroke.width, withStroke.height]).toEqual([strokeOnly.width, strokeOnly.height]);
  });

  describe('ruled lines whose edges fall between pixel rows after shrinking (Task 62 Rev 2)', () => {
    // Lines every 97 source rows, 6 rows thick: 97 is not a multiple of the 1.875 source rows each output row
    // covers, so the lines land at every kind of offset and leave pale, half-covered edge rows after shrinking.
    const paper = (x: number, y: number): [number, number, number, number] => {
      const shade = Math.round(250 - 18 * x / 2999 - 14 * y / 1999);
      return [shade, shade - 6, shade - 24, 255];
    };
    const onStroke = (x: number, y: number) => x >= 900 && x <= 2100 && Math.abs(y - (700 + (x - 900) / 5)) <= 7;
    const notebook = (withLines: boolean, withStroke: boolean) => shrinkForCleaning(image(3000, 2000, (x, y) => {
      if (withStroke && onStroke(x, y)) return [10, 14, 22, 255];
      if (withLines && x >= 361 && x < 365) return [214, 118, 126, 255];
      if (withLines && (y + 11) % 97 < 6) return [160, 196, 232, 255];
      return paper(x, y);
    }));
    const linesOnly = notebook(true, false);
    const withStroke = notebook(true, true);
    const strokeOnly = notebook(false, true);

    it.each([20, 50, 80])('leaves no faint streaks at cleaning strength %i', (strength) => {
      const result = cleanSignature(linesOnly, { strength, removeLines: true, ink: 'original' });
      expect(visible(result).filter((alpha) => alpha > 20)).toHaveLength(0);
    });

    it('never erases a straight pen underline that runs across the page like a ruled line', () => {
      const underlined = shrinkForCleaning(image(3000, 2000, (x, y) => {
        if (x >= 300 && x <= 2700 && y >= 1200 && y < 1206) return [12, 16, 26, 255];
        if ((y + 11) % 97 < 6) return [160, 196, 232, 255];
        return paper(x, y);
      }));
      const result = cleanSignature(underlined, { strength: 50, removeLines: true, ink: 'original' });
      expect(result.width).toBeGreaterThan(1200);
      expect(visible(result).filter((alpha) => alpha > 200).length).toBeGreaterThan(2000);
    });

    it('removes a bold red margin but keeps a straight blue pen stroke just as long', () => {
      const page = image(400, 300, (x, y) => {
        if (x >= 200 && x < 203 && y >= 20 && y < 280) return [30, 50, 120, 255];
        if (x >= 40 && x < 43) return [200, 40, 50, 255];
        if (y % 24 < 2) return [160, 196, 232, 255];
        return [250, 246, 225, 255];
      });
      const result = cleanSignature(page, { strength: 50, removeLines: true, ink: 'original' });
      const alphas = visible(result);
      expect(alphas.filter((alpha) => alpha > 200).length).toBeGreaterThan(700);
      expect(alphas.filter((alpha) => alpha > 20).length).toBeLessThan(900);
      expect(result.width).toBeLessThan(40);
    });

    it.each([20, 50, 80])('crops to the signature, not to leftover line bits, at strength %i', (strength) => {
      const options = { strength, removeLines: true, ink: 'original' } as const;
      const cleaned = cleanSignature(withStroke, options);
      const reference = cleanSignature(strokeOnly, options);
      expect(Math.abs(cleaned.width - reference.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(cleaned.height - reference.height)).toBeLessThanOrEqual(2);
      const ink = (imageData: ImageData) => visible(imageData).filter((alpha) => alpha > 60).length;
      expect(ink(cleaned) / ink(reference)).toBeGreaterThan(0.9);
    });
  });

  it('makes white paper transparent and keeps a black stroke', () => {
    const source = image(96, 64, (x, y) => (x >= 20 && x <= 75 && Math.abs(y - 32) <= 2)
      ? [5, 5, 5, 255] : [255, 255, 255, 255]);
    const result = cleanSignature(source, { strength: 50, removeLines: false, ink: 'original' });
    expect(result.width).toBeLessThan(source.width);
    expect(Math.max(...visible(result))).toBe(255);
    expect(visible(result).filter((alpha) => alpha === 0).length).toBeGreaterThan(0);
  });

  it('removes yellow paper under a grey shadow gradient', () => {
    const source = image(128, 72, (x, y) => {
      if (x > 28 && x < 100 && Math.abs(y - (24 + x / 5)) < 2) return [20, 30, 45, 255];
      const shade = Math.round(245 - x * 0.25);
      return [shade, Math.max(0, shade - 18), Math.max(0, shade - 45), 255];
    });
    const result = cleanSignature(source, { strength: 55, removeLines: false, ink: 'black' });
    const alphas = visible(result);
    expect(alphas.some((alpha) => alpha > 220)).toBe(true);
    expect(alphas.filter((alpha) => alpha < 5).length).toBeGreaterThan(alphas.length / 3);
  });

  it('removes notebook ruling but preserves darker crossing ink', () => {
    const source = image(160, 100, (x, y) => {
      if (Math.abs(x - 80) <= 2 && y > 10 && y < 90) return [5, 5, 5, 255];
      if (x === 22) return [215, 95, 105, 255];
      if (y % 24 <= 1) return [175, 205, 235, 255];
      return [250, 246, 225, 255];
    });
    const result = cleanSignature(source, { strength: 80, removeLines: true, ink: 'black' });
    const alphas = visible(result);
    expect(alphas.filter((alpha) => alpha > 180).length).toBeGreaterThan(40);
    expect(alphas.filter((alpha) => alpha > 20).length).toBeLessThan(500);
  });

  it('keeps more faint ink at a higher cleaning strength and recolours it', () => {
    const source = image(80, 50, (x, y) => (x > 15 && x < 65 && Math.abs(y - 25) <= 2)
      ? [190, 190, 190, 255] : [250, 250, 250, 255]);
    const low = cleanSignature(source, { strength: 20, removeLines: false, ink: 'black' });
    const high = cleanSignature(source, { strength: 80, removeLines: false, ink: 'blue' });
    const lowAlpha = visible(low).reduce((sum, value) => sum + value, 0);
    const highAlpha = visible(high).reduce((sum, value) => sum + value, 0);
    expect(highAlpha).toBeGreaterThan(lowAlpha);
    const opaque = high.data.findIndex((_, offset) => offset % 4 === 3 && high.data[offset]! > 30);
    expect(high.data[opaque - 3]).toBe(22);
    expect(high.data[opaque - 2]).toBe(76);
    expect(high.data[opaque - 1]).toBe(166);
  });

  it('trims to the ink and includes transparent padding', () => {
    const source = image(30, 20, (x, y) => (x >= 10 && x <= 14 && y >= 7 && y <= 9)
      ? [0, 0, 0, 255] : [0, 0, 0, 0]);
    const result = trimToInk(source, 3);
    expect([result.width, result.height]).toEqual([11, 9]);
    expect(result.data[3]).toBe(0);
    expect(Math.max(...visible(result))).toBe(255);
  });

  it('preserves an already-transparent PNG edge', () => {
    const source = image(40, 30, (x, y) => (x > 8 && x < 32 && y > 12 && y < 17)
      ? [30, 40, 55, 180] : [0, 0, 0, 0]);
    const result = cleanSignature(source, { strength: 50, removeLines: true, ink: 'original' });
    expect(Math.max(...visible(result))).toBe(180);
    expect(result.data.some((value, offset) => offset % 4 === 0 && value === 30)).toBe(true);
  });
});
