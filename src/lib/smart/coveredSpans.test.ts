import { describe, expect, it } from 'vitest';
import { filterCoveredSpans } from './coveredSpans';

const span = { id: 'span', rect: { x: 20, y: 40, w: 80, h: 12 } };

describe('filterCoveredSpans', () => {
  it('drops a span underneath a cover', () => {
    expect(filterCoveredSpans([span], [{ x: 10, y: 35, w: 100, h: 24 }])).toEqual([]);
  });

  it('keeps a span outside a cover', () => {
    expect(filterCoveredSpans([span], [{ x: 120, y: 35, w: 20, h: 24 }])).toEqual([span]);
  });

  it('drops a span when a top-trimmed cover still overlaps at least half its area', () => {
    expect(filterCoveredSpans([span], [{ x: 15, y: 40, w: 90, h: 6 }])).toEqual([]);
  });

  it('keeps a span when less than half its area is covered', () => {
    expect(filterCoveredSpans([span], [{ x: 15, y: 40, w: 90, h: 5.9 }])).toEqual([span]);
  });
});
