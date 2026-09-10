import { describe, expect, it } from 'vitest';
import { placeSelectionToolbar, toolbarOffsetInFrame } from './floatingToolbar';

describe('placeSelectionToolbar', () => {
  const page = { width: 800, height: 1000 };
  const toolbar = { width: 260, height: 40 };

  it('follows the frame and sits above it when there is room', () => {
    expect(placeSelectionToolbar({ left: 100, top: 300, width: 200, height: 150 }, toolbar, page))
      .toEqual({ left: 100, top: 248 });
  });

  it('is pulled back inside the page at the right edge', () => {
    const placed = placeSelectionToolbar({ left: 700, top: 300, width: 90, height: 150 }, toolbar, page);
    expect(placed.left).toBe(540);
    expect(placed.left + toolbar.width).toBeLessThanOrEqual(page.width);
  });

  it('goes below the frame when there is no room above', () => {
    expect(placeSelectionToolbar({ left: 0, top: 20, width: 200, height: 150 }, toolbar, page))
      .toEqual({ left: 0, top: 182 });
  });

  it('stays inside the page when neither above nor below fits', () => {
    const placed = placeSelectionToolbar({ left: 0, top: 10, width: 800, height: 980 }, toolbar, page);
    expect(placed.top).toBe(960);
    expect(placed.top + toolbar.height).toBeLessThanOrEqual(page.height);
  });

  it('never goes past the left edge on a page narrower than the bar', () => {
    const placed = placeSelectionToolbar(
      { left: 30, top: 300, width: 50, height: 50 },
      toolbar,
      { width: 200, height: 400 },
    );
    expect(placed.left).toBe(0);
  });

  it('uses a custom gap', () => {
    expect(placeSelectionToolbar({ left: 100, top: 300, width: 200, height: 150 }, toolbar, page, 8).top)
      .toBe(252);
  });
});

describe('toolbarOffsetInFrame', () => {
  it('expresses the placement relative to the frame corner', () => {
    const page = { width: 800, height: 1000 };
    const toolbar = { width: 260, height: 40 };
    expect(toolbarOffsetInFrame({ left: 700, top: 300, width: 90, height: 150 }, toolbar, page))
      .toEqual({ left: -160, top: -52 });
  });
});
