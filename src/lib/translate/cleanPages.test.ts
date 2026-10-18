import { describe, expect, it, vi } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import { CleanPageCache } from './cleanPages';
import { isFlatTextBackground } from './translationPatch';

vi.mock('@/lib/pdf/worker', () => ({ pdfjs: {} }));
vi.mock('@/lib/pdf/pagePreviewService', () => ({ acquirePagePreviewService: vi.fn() }));
const clean = (name: string) => ({ page: { name } as unknown as PDFPageProxy, destroy: vi.fn(async () => undefined) });

describe('clean pages for translation', () => {
  it('makes each page once and keeps only the most recently used few', async () => {
    const cache = new CleanPageCache(2), made = new Map<string, ReturnType<typeof clean>>();
    const create = (key: string) => vi.fn(async () => { const value = clean(key); made.set(key, value); return value; });
    const first = create('p1');
    expect(await cache.get('p1', first)).toEqual({ name: 'p1' });
    await cache.get('p1', create('p1-again'));
    expect(first).toHaveBeenCalledTimes(1);
    await cache.get('p2', create('p2'));
    await cache.get('p1', create('unused'));
    await cache.get('p3', create('p3'));
    await vi.waitFor(() => expect(made.get('p2')!.destroy).toHaveBeenCalled());
    expect(made.get('p1')!.destroy).not.toHaveBeenCalled();
    cache.clear();
    await vi.waitFor(() => expect(made.get('p3')!.destroy).toHaveBeenCalled());
    expect(made.get('p1')!.destroy).toHaveBeenCalled();
  });
  it('forgets a page that could not be made, so the next look tries again', async () => {
    const cache = new CleanPageCache();
    await expect(cache.get('p1', async () => { throw new Error('unsafe'); })).rejects.toThrow('unsafe');
    expect(await cache.get('p1', async () => clean('p1'))).toEqual({ name: 'p1' });
  });
});

describe('patches behind early translated words', () => {
  const white = { r: 1, g: 1, b: 1 }, black = { r: 0, g: 0, b: 0 };
  // A 10 × 10 patch whose middle 6 × 6 is the text box.
  const inner = { left: 2, top: 2, right: 8, bottom: 8 };
  const patch = (colour: (x: number, y: number) => number[]) => new Uint8ClampedArray(Array.from({ length: 100 },
    (_, index) => [...colour(index % 10, Math.floor(index / 10)), 255]).flat());
  const isInner = (x: number, y: number) => x >= 2 && x < 8 && y >= 2 && y < 8;
  it('treats text on a flat colour, with anti-aliased edges, as flat', () => {
    expect(isFlatTextBackground(patch((x, y) => !isInner(x, y) ? [255, 255, 255]
      : x === 3 ? [0, 0, 0] : x === 4 ? [128, 128, 128] : [255, 255, 255]), 10, inner, white, black)).toBe(true);
  });
  it('allows a rule in the text colour through the margin, as above and below a section heading', () => {
    expect(isFlatTextBackground(patch((_x, y) => y === 0 || y === 9 ? [0, 0, 0] : [255, 255, 255]), 10, inner, white, black)).toBe(true);
  });
  it('treats a photograph as not flat', () => {
    expect(isFlatTextBackground(patch((x, y) => [(x * 37 + y * 11) % 256, (x * 91) % 256, (y * 53) % 256]), 10, inner, white, black)).toBe(false);
  });
  it('treats light text on a gradient as not flat, though the gradient looks like anti-aliasing', () => {
    const dark = { r: 10 / 255, g: 60 / 255, b: 45 / 255 };
    // Dark green fading towards white across the patch: every pixel lies between the text and background colours.
    const gradient = (x: number) => [10 + x * 8, 60 + x * 6, 45 + x * 7];
    expect(isFlatTextBackground(patch(x => gradient(x)), 10, inner, dark, white)).toBe(false);
  });
});
