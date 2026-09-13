import { describe, expect, it } from 'vitest';
import { LEVELS, LEVEL_LADDER, targetSize } from './levels';

describe('compression levels', () => {
  it('defines the promised gentle-to-small ladder', () => {
    expect(LEVEL_LADDER).toEqual(['light', 'medium', 'strong', 'smallest']);
    expect(LEVELS.medium).toMatchObject({ dpi: 150, quality: 0.75 });
    expect(LEVELS.smallest).toMatchObject({ dpi: 80, quality: 0.5 });
  });

  it('targets the limiting drawn axis and keeps the pixel aspect ratio', () => {
    const result = targetSize({ width: 3000, height: 2000, drawnWidthPt: 288, drawnHeightPt: 144 }, 150);
    expect(result).toMatchObject({ width: 600, height: 400 });
    expect(result.width / result.height).toBeCloseTo(1.5);
  });

  it('never enlarges and keeps both sides at least 16 pixels', () => {
    expect(targetSize({ width: 100, height: 80, drawnWidthPt: 500, drawnHeightPt: 400 }, 200))
      .toMatchObject({ width: 100, height: 80, scale: 1 });
    expect(targetSize({ width: 6400, height: 64, drawnWidthPt: 10, drawnHeightPt: 0.1 }, 80))
      .toMatchObject({ width: 1600, height: 16, scale: 0.25 });
  });
});
