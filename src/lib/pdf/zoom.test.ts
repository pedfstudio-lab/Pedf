import { describe, expect, it } from 'vitest';

import {
  captureZoomAnchor,
  clampZoom,
  scrollPositionForZoomAnchor,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from './zoom';

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

describe('zoom focal anchoring', () => {
  it('captures the viewport center as vertical and horizontal content fractions', () => {
    expect(captureZoomAnchor({
      scrollTop: 600,
      scrollLeft: 300,
      scrollHeight: 2_000,
      scrollWidth: 1_800,
      clientHeight: 400,
      clientWidth: 600,
    })).toEqual({ v: 0.4, h: 1 / 3 });
  });

  it('maps the same focal fractions onto resized content', () => {
    expect(scrollPositionForZoomAnchor(
      { v: 0.4, h: 1 / 3 },
      {
        scrollHeight: 3_000,
        scrollWidth: 2_700,
        clientHeight: 400,
        clientWidth: 600,
      },
    )).toEqual({ top: 1_000, left: 600 });
  });

  it('uses zero fractions when content has no measurable extent', () => {
    expect(captureZoomAnchor({
      scrollTop: 0,
      scrollLeft: 0,
      scrollHeight: 0,
      scrollWidth: 0,
      clientHeight: 400,
      clientWidth: 600,
    })).toEqual({ v: 0, h: 0 });
  });
});
