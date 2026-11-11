// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { pageInView, scrollPageIntoView } from './pageInView';

// A scrolling area 800px tall at the top of the window, with page boxes at the given
// on-screen positions (as getBoundingClientRect reports them after scrolling).
function viewer(pages: ReadonlyArray<readonly [top: number, bottom: number]>) {
  const scroll = document.createElement('div');
  Object.defineProperty(scroll, 'clientHeight', { value: 800 });
  scroll.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 800);
  pages.forEach(([top, bottom], index) => {
    const box = document.createElement('div');
    box.dataset.pageIndex = String(index);
    box.getBoundingClientRect = () => new DOMRect(0, top, 600, bottom - top);
    // An off-screen drawing canvas, like the real pages have: must never count.
    box.appendChild(document.createElement('canvas'));
    scroll.appendChild(box);
  });
  return scroll;
}

describe('pageInView', () => {
  it('finds the last page when the user has scrolled down to it', () => {
    const scroll = viewer([[-5000, -4000], [-3900, -2900], [-2800, -1800], [-1700, -700], [-600, 400], [500, 1500]]);
    // The middle of the area (400px) touches page 5's bottom edge; page 6 starts 100px below.
    expect(pageInView(scroll)).toBe(4);
    const lower = viewer([[-5000, -4000], [-3900, -2900], [-2800, -1800], [-1700, -700], [-1300, -300], [-200, 800]]);
    expect(pageInView(lower)).toBe(5);
  });

  it('picks the closest page when the middle falls in the gap between two', () => {
    expect(pageInView(viewer([[-600, 380], [430, 1400]]))).toBe(0);
    expect(pageInView(viewer([[-600, 370], [410, 1400]]))).toBe(1);
  });

  it('falls back to page 1 when there are no pages yet', () => {
    expect(pageInView(viewer([]))).toBe(0);
  });
});

describe('scrollPageIntoView', () => {
  it('scrolls so the middle of the page sits in the middle of the area', () => {
    const scroll = viewer([[100, 1100], [1200, 2200], [2300, 3300]]);
    scroll.scrollTop = 0;
    scrollPageIntoView(scroll, 2);
    // Page 3's middle is at 2800px; the area's middle is at 400px.
    expect(scroll.scrollTop).toBe(2400);
  });
});
