import { describe, expect, it } from 'vitest';
import { outsideBandRects } from './outsideBackground';

describe('outsideBandRects', () => {
  it('returns four bands outside an interior image', () => {
    expect(outsideBandRects(
      { left: 20, top: 30, width: 40, height: 50 },
      100,
      120,
      5,
    )).toEqual([
      { left: 15, top: 25, width: 50, height: 5 },
      { left: 15, top: 80, width: 50, height: 5 },
      { left: 15, top: 30, width: 5, height: 50 },
      { left: 60, top: 30, width: 5, height: 50 },
    ]);
  });

  it('clips bands at page edges without sampling inside the image', () => {
    expect(outsideBandRects(
      { left: 0, top: 0, width: 90, height: 90 },
      100,
      100,
      5,
    )).toEqual([
      { left: 0, top: 90, width: 95, height: 5 },
      { left: 90, top: 0, width: 5, height: 90 },
    ]);
  });
});
