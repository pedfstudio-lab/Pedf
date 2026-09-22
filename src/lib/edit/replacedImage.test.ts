import { describe, expect, it } from 'vitest';
import type { DrawnImage, ImageRegion } from '@/lib/pdf/images';
import { replacedImageFor } from './replacedImage';

describe('replacedImageFor', () => {
  const region: ImageRegion = {
    pageIndex: 2,
    rect: { x: 20, y: 30, w: 80, h: 40 },
  };

  it('records the matching draw kind and rectangle without its temporary PDF.js id', () => {
    const draw: DrawnImage = {
      region: { pageIndex: 2, rect: { ...region.rect } },
      visibleRect: { ...region.rect },
      widthPt: 80,
      heightPt: 40,
      objectId: 'img_p2_9',
      kind: 'mask',
    };

    expect(replacedImageFor(region, [draw])).toEqual({
      kind: 'mask',
      rect: region.rect,
    });
  });

  it('records a trimmed draw by its visible rectangle', () => {
    const draw: DrawnImage = {
      region: { pageIndex: 2, rect: { x: 20, y: 0, w: 80, h: 100 } },
      visibleRect: { ...region.rect },
      widthPt: 80,
      heightPt: 100,
      kind: 'image',
    };

    expect(replacedImageFor(region, [draw])).toEqual({
      kind: 'image',
      rect: region.rect,
    });
  });

  it('falls back to a normal image claim when no retained draw is available', () => {
    expect(replacedImageFor(region, [])).toEqual({
      kind: 'image',
      rect: region.rect,
    });
  });
});
