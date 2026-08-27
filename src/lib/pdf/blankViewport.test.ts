import { describe, expect, it } from 'vitest';
import { pdfToViewport, viewportToPdf } from '@/lib/export/coordinates';
import { createBlankViewport } from './blankViewport';

describe('createBlankViewport', () => {
  it('scales the blank page dimensions', () => {
    const viewport = createBlankViewport(612, 792, 2.5);
    expect(viewport.width).toBe(1530);
    expect(viewport.height).toBe(1980);
  });

  it('round-trips PDF points through the top-left viewport coordinate system', () => {
    const viewport = createBlankViewport(612, 792, 1.75);
    const original = { x: 123.45, y: 678.9 };
    const viewportPoint = pdfToViewport(viewport, original);
    const roundTrip = viewportToPdf(viewport, viewportPoint);

    expect(viewportPoint.x).toBeCloseTo(original.x * 1.75);
    expect(viewportPoint.y).toBeCloseTo((792 - original.y) * 1.75);
    expect(roundTrip.x).toBeCloseTo(original.x);
    expect(roundTrip.y).toBeCloseTo(original.y);
  });
});
