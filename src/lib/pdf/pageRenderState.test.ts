import { describe, expect, it } from 'vitest';

import { shouldRasterizeInitially, samePageRenderIdentity } from './pageRenderState';

describe('samePageRenderIdentity', () => {
  const page = {};

  it('keeps render state valid when the page identity is unchanged across zoom', () => {
    const beforeZoom = { page, pageIndex: 2 };
    const afterZoom = { page, pageIndex: 2 };

    expect(samePageRenderIdentity(beforeZoom, afterZoom)).toBe(true);
  });

  it('invalidates render state when the PDF page or page position changes', () => {
    const current = { page, pageIndex: 2 };

    expect(samePageRenderIdentity(current, { page: {}, pageIndex: 2 })).toBe(false);
    expect(samePageRenderIdentity(current, { page, pageIndex: 3 })).toBe(false);
  });

  it('keeps equivalent blank pages stable but invalidates changed geometry', () => {
    const blank = { page: undefined, pageIndex: 4, blankWidth: 612, blankHeight: 792 };

    expect(samePageRenderIdentity(blank, { ...blank })).toBe(true);
    expect(samePageRenderIdentity(blank, { ...blank, blankWidth: 700 })).toBe(false);
    expect(samePageRenderIdentity(blank, { ...blank, blankHeight: 900 })).toBe(false);
  });
});

describe('shouldRasterizeInitially', () => {
  it('renders the first page immediately and defers later pages when observation is available', () => {
    expect(shouldRasterizeInitially(0, true)).toBe(true);
    expect(shouldRasterizeInitially(1, true)).toBe(false);
    expect(shouldRasterizeInitially(40, true)).toBe(false);
  });

  it('falls back to eager rendering when IntersectionObserver is unavailable', () => {
    expect(shouldRasterizeInitially(8, false)).toBe(true);
  });
});
