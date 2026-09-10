import { describe, expect, it } from 'vitest';
import {
  isBackgroundRegion,
  POINTS_PER_MM,
  moveScreenRect,
  resizePdfRectByMillimetres,
  resizeScreenRect,
} from './useImageRectTransform';

describe('image rectangle transforms', () => {
  it('recognizes image regions covering at least 90% of the page as backgrounds', () => {
    const page = { x: 0, y: 0, w: 300, h: 400 };
    expect(isBackgroundRegion({ x: 0, y: 0, w: 300, h: 360 }, page)).toBe(true);
    expect(isBackgroundRegion({ x: 0, y: 0, w: 300, h: 359 }, page)).toBe(false);
    expect(isBackgroundRegion({ x: 20, y: 40, w: 80, h: 40 }, page)).toBe(false);
  });

  it('recognizes only regions covering at least 90% of the page as backgrounds', () => {
    const page = { x: 0, y: 0, w: 300, h: 400 };
    expect(isBackgroundRegion({ x: 0, y: 0, w: 300, h: 400 }, page)).toBe(true);
    expect(isBackgroundRegion({ x: 0, y: 0, w: 270, h: 400 }, page)).toBe(true);
    expect(isBackgroundRegion({ x: 0, y: 0, w: 269, h: 400 }, page)).toBe(false);
  });

  it('moves within page edges', () => {
    const rect = { left: 10, top: 20, width: 80, height: 40 };
    expect(moveScreenRect(rect, -50, 200, 200, 160)).toEqual({
      left: 0,
      top: 120,
      width: 80,
      height: 40,
    });
  });

  it('resizes from every corner with its aspect ratio locked', () => {
    const rect = { left: 60, top: 50, width: 100, height: 50 };
    for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
      const resized = resizeScreenRect(rect, corner, 20, 10, 300, 220, 20);
      expect(resized.width / resized.height).toBeCloseTo(2);
      expect(resized.left).toBeGreaterThanOrEqual(0);
      expect(resized.top).toBeGreaterThanOrEqual(0);
      expect(resized.left + resized.width).toBeLessThanOrEqual(300);
      expect(resized.top + resized.height).toBeLessThanOrEqual(220);
    }
  });

  it('converts an exact width in millimetres and recomputes height', () => {
    const rect = { x: 40, y: 50, w: 120, h: 60 };
    const resized = resizePdfRectByMillimetres(
      rect,
      { x: 0, y: 0, w: 500, h: 400 },
      'width',
      50,
    );
    expect(resized.w).toBeCloseTo(50 * POINTS_PER_MM);
    expect(resized.h).toBeCloseTo(25 * POINTS_PER_MM);
  });

  it('keeps exact sizes inside the page and above the minimum', () => {
    const rect = { x: 450, y: 350, w: 40, h: 80 };
    const resized = resizePdfRectByMillimetres(
      rect,
      { x: 0, y: 0, w: 500, h: 400 },
      'width',
      2,
    );
    expect(resized.w).toBeGreaterThanOrEqual(20);
    expect(resized.h).toBeGreaterThanOrEqual(20);
    expect(resized.x + resized.w).toBeLessThanOrEqual(500);
    expect(resized.y + resized.h).toBeLessThanOrEqual(400);
  });
});
