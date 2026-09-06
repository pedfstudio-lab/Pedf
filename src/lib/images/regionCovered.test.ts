import { describe, expect, it } from 'vitest';
import type { PdfRect } from '@/lib/export/types';
import { isRegionCovered } from './regionCovered';

const region: PdfRect = { x: 20, y: 30, w: 40, h: 50 };

describe('isRegionCovered', () => {
  it('accepts a cover with the same rectangle', () => {
    expect(isRegionCovered(region, region)).toBe(true);
  });

  it('accepts a cover expanded by 8 points on every side', () => {
    expect(isRegionCovered(
      { x: 12, y: 22, w: 56, h: 66 },
      region,
    )).toBe(true);
  });

  it.each([
    ['left', { x: 21, y: 30, w: 39, h: 50 }],
    ['bottom', { x: 20, y: 31, w: 40, h: 49 }],
    ['right', { x: 20, y: 30, w: 39, h: 50 }],
    ['top', { x: 20, y: 30, w: 40, h: 49 }],
  ] as const)('rejects a cover when the region pokes out on the %s', (_side, cover) => {
    expect(isRegionCovered(cover, region)).toBe(false);
  });

  it('does not hide a neighbouring region that only touches the cover edge', () => {
    const cover: PdfRect = { x: 0, y: 0, w: 10, h: 10 };
    const neighbour: PdfRect = { x: 10, y: 0, w: 10, h: 10 };

    expect(isRegionCovered(cover, neighbour)).toBe(false);
  });
});
