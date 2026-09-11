import { describe, expect, it } from 'vitest';
import { autoFontSize, centreRange, watermarkPlacements } from './watermarkLayout';
import type { WatermarkAngle, WatermarkPosition } from './watermarkOptions';

function centreOf(u: number, v: number, width: number, height: number, angle: number) {
  const radians = angle * Math.PI / 180;
  return {
    x: u + width * Math.cos(radians) / 2 - height * Math.sin(radians) / 2,
    y: v + width * Math.sin(radians) / 2 + height * Math.cos(radians) / 2,
  };
}

describe('watermark layout', () => {
  it.each([0, 45, -45, 90] as const)('centres a rotated item at %i°', (angle) => {
    const [placement] = watermarkPlacements({ pageWidth: 600, pageHeight: 800, itemWidth: 220,
      itemHeight: 36, angle, position: 'c', margin: 30 });
    expect(placement).toBeTruthy();
    const centre = centreOf(placement!.u, placement!.v, 220, 36, angle);
    expect(centre.x).toBeCloseTo(300, 8);
    expect(centre.y).toBeCloseTo(400, 8);
  });

  it.each(['tl', 't', 'tr', 'l', 'r', 'bl', 'b', 'br'] as WatermarkPosition[])('keeps %s inside its requested margin', (position) => {
    const [placement] = watermarkPlacements({ pageWidth: 600, pageHeight: 800, itemWidth: 140,
      itemHeight: 30, angle: 45, position, margin: 30 });
    expect(placement!.u).toBeTypeOf('number');
    expect(placement!.v).toBeTypeOf('number');
    const radians = Math.PI / 4;
    const points = [[0, 0], [140, 0], [0, 30], [140, 30]].map(([x, y]) => ({
      x: placement!.u + x! * Math.cos(radians) - y! * Math.sin(radians),
      y: placement!.v + x! * Math.sin(radians) + y! * Math.cos(radians),
    }));
    expect(Math.min(...points.map((point) => point.x))).toBeGreaterThanOrEqual(29.999);
    expect(Math.max(...points.map((point) => point.x))).toBeLessThanOrEqual(570.001);
    expect(Math.min(...points.map((point) => point.y))).toBeGreaterThanOrEqual(29.999);
    expect(Math.max(...points.map((point) => point.y))).toBeLessThanOrEqual(770.001);
  });

  it('puts a dragged spot at the same share of the page, measured from the top', () => {
    const [placement] = watermarkPlacements({ pageWidth: 600, pageHeight: 800, itemWidth: 100,
      itemHeight: 20, angle: 0, position: 'custom', margin: 30, custom: { x: 0.25, y: 0.25 } });
    const centre = centreOf(placement!.u, placement!.v, 100, 20, 0);
    expect(centre.x).toBeCloseTo(150, 8);
    expect(centre.y).toBeCloseTo(600, 8);
  });

  it('keeps a dragged, turned item entirely on the page', () => {
    const [placement] = watermarkPlacements({ pageWidth: 600, pageHeight: 800, itemWidth: 140,
      itemHeight: 30, angle: 45, position: 'custom', margin: 30, custom: { x: 1, y: 0 } });
    const radians = Math.PI / 4;
    const points = [[0, 0], [140, 0], [0, 30], [140, 30]].map(([x, y]) => ({
      x: placement!.u + x! * Math.cos(radians) - y! * Math.sin(radians),
      y: placement!.v + x! * Math.sin(radians) + y! * Math.cos(radians),
    }));
    expect(Math.max(...points.map((point) => point.x))).toBeCloseTo(600, 6);
    expect(Math.max(...points.map((point) => point.y))).toBeCloseTo(800, 6);
    expect(Math.min(...points.map((point) => point.x))).toBeGreaterThan(0);
    expect(Math.min(...points.map((point) => point.y))).toBeGreaterThan(0);
  });

  it('centres an item that is bigger than the page instead of pushing it off', () => {
    expect(centreRange(100, 100, 300, 20, 0)).toEqual({ minX: 50, maxX: 50, minY: 10, maxY: 90 });
  });

  it('creates a useful centred tile field for an A4 page', () => {
    const placements = watermarkPlacements({ pageWidth: 595, pageHeight: 842, itemWidth: 200,
      itemHeight: 40, angle: 45, position: 'tile', margin: 30 });
    expect(placements.length).toBeGreaterThanOrEqual(6);
    expect(placements.length).toBeLessThanOrEqual(30);
    const centres = placements.map(({ u, v }) => centreOf(u, v, 200, 40, 45));
    expect(centres.some(({ x, y }) => Math.hypot(x - 297.5, y - 421) < 1)).toBe(true);
  });

  it('auto-size grows with the target dimension and clamps from 12 to 200', () => {
    expect(autoFontSize(5, 100, 200, 0)).toBe(12);
    expect(autoFontSize(1, 1000, 1000, 0)).toBe(200);
    expect(autoFontSize(10, 400, 800, 0)).toBe(24);
    expect(autoFontSize(10, 800, 800, 0)).toBe(48);
    expect(autoFontSize(10, 400, 800, 90)).toBe(48);
    expect(autoFontSize(10, 300, 400, 45)).toBe(30);
  });

  it('returns finite placements for every supported position and angle', () => {
    const positions: WatermarkPosition[] = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br', 'tile'];
    const angles: WatermarkAngle[] = [45, 0, -45, 90];
    for (const position of positions) for (const angle of angles) {
      const placements = watermarkPlacements({ pageWidth: 100, pageHeight: 200, itemWidth: 30,
        itemHeight: 10, angle, position, margin: 5 });
      expect(placements.length).toBeGreaterThan(0);
      expect(placements.every(({ u, v }) => Number.isFinite(u) && Number.isFinite(v))).toBe(true);
    }
  });
});
