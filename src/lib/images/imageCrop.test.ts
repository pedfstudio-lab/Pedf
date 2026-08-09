import { describe, expect, it } from 'vitest';
import { cropRectToPixels } from './imageCrop';

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
