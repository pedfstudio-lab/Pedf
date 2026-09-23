import { describe, expect, it } from 'vitest';
import { cropRectToPixels, sourcePixelCrop } from './imageCrop';

describe('cropRectToPixels', () => {
  it('maps PDF bottom-left coordinates into image top-left pixels', () => {
    expect(cropRectToPixels(
      { x: 10, y: 20, w: 200, h: 100 },
      { x: 60, y: 45, w: 100, h: 50 },
      1000,
      500,
    )).toEqual({ left: 250, top: 125, width: 500, height: 250 });
  });

  it('clamps a crop to the displayed image bounds', () => {
    expect(cropRectToPixels(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: -20, y: 50, w: 70, h: 70 },
      400,
      200,
    )).toEqual({ left: 0, top: 0, width: 200, height: 100 });
  });

  it('rejects a crop outside the image', () => {
    expect(() => cropRectToPixels(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 120, y: 120, w: 10, h: 10 },
      400,
      200,
    )).toThrow('must overlap');
  });
});

describe('sourcePixelCrop', () => {
  const placed = { x: 10, y: 20, w: 200, h: 100 };
  const pixels = { width: 1000, height: 500 };

  it('maps an ordinary PDF placement into original source pixels', () => {
    expect(sourcePixelCrop(
      placed,
      placed,
      { x: 60, y: 45, w: 100, h: 50 },
      pixels,
      [200, 0, 0, -100, 10, 380],
    )).toEqual({ left: 250, top: 125, width: 500, height: 250 });
  });

  it('intersects the crop with the visible clipped rectangle', () => {
    expect(sourcePixelCrop(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 25, y: 20, w: 50, h: 60 },
      { x: 0, y: 0, w: 80, h: 90 },
      pixels,
      [100, 0, 0, -100, 0, 400],
    )).toEqual({ left: 250, top: 100, width: 500, height: 300 });
  });

  it('reverses source intervals for horizontal and vertical flips', () => {
    const box = { x: 0, y: 0, w: 100, h: 100 };
    const crop = { x: 0, y: 75, w: 25, h: 25 };
    expect(sourcePixelCrop(box, box, crop, { width: 400, height: 200 }, [
      -100, 0, 0, -100, 100, 400,
    ])).toEqual({ left: 300, top: 0, width: 100, height: 50 });
    expect(sourcePixelCrop(box, box, crop, { width: 400, height: 200 }, [
      100, 0, 0, 100, 0, 300,
    ])).toEqual({ left: 0, top: 150, width: 100, height: 50 });
  });

  it('clamps a crop extending past the placed image', () => {
    expect(sourcePixelCrop(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 0, y: 0, w: 100, h: 100 },
      { x: -20, y: -10, w: 140, h: 130 },
      { width: 400, height: 200 },
      [100, 0, 0, -100, 0, 400],
    )).toEqual({ left: 0, top: 0, width: 400, height: 200 });
  });

  it('returns null for rotated, skewed, missing, or non-overlapping placements', () => {
    const crop = { x: 20, y: 20, w: 20, h: 20 };
    expect(sourcePixelCrop(placed, placed, crop, pixels, [200, 0.02, 0, -100, 0, 0])).toBeNull();
    expect(sourcePixelCrop(placed, placed, crop, pixels, [200, 0, -0.02, -100, 0, 0])).toBeNull();
    expect(sourcePixelCrop(placed, placed, crop, pixels)).toBeNull();
    expect(sourcePixelCrop(placed, placed, { x: 500, y: 500, w: 10, h: 10 }, pixels, [
      200, 0, 0, -100, 0, 0,
    ])).toBeNull();
  });
});
