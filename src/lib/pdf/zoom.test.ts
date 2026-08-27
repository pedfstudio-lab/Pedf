import { describe, expect, it } from 'vitest';

import { clampZoom, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from './zoom';

describe('clampZoom', () => {
  it('clamps zoom to the supported range', () => {
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(10)).toBe(ZOOM_MAX);
  });

  it('keeps quarter-step zoom values stable', () => {
    expect(clampZoom(1 + ZOOM_STEP)).toBe(1.25);
    expect(clampZoom(1.5 - ZOOM_STEP)).toBe(1.25);
  });

  it('rounds floating-point drift to two decimal places', () => {
    expect(clampZoom(1.0000000000001)).toBe(1);
    expect(clampZoom(1.2499999999999)).toBe(1.25);
  });
});
