// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  createEntries,
  duplicatePage,
  fileKey,
  insertBlankAfter,
  isIdentityPlan,
  movePage,
  parsePlan,
  reconcilePlan,
  removePage,
  rotatePage,
  type OrganizeEntry,
} from './organizePlan';

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

const pages: OrganizeEntry[] = [
  { id: 'a1', kind: 'page', fileKey: 'a', pageIndex: 0, turns: 0 },
  { id: 'a2', kind: 'page', fileKey: 'a', pageIndex: 1, turns: 0 },
  { id: 'a3', kind: 'page', fileKey: 'a', pageIndex: 2, turns: 0 },
];

describe('organize plan', () => {
  it('builds a stable file key and source entries', () => {
    const file = new File(['abc'], 'sample.pdf', { lastModified: 123 });
    expect(fileKey(file)).toBe('sample.pdf|3|123');
    expect(createEntries('a', 2, ids('one', 'two'))).toEqual(pages.slice(0, 2).map((entry, index) => ({
      ...entry, id: index === 0 ? 'one' : 'two',
    })));
    expect(() => createEntries('a', -1, ids())).toThrow(RangeError);
  });

  it('moves pages and clamps the destination', () => {
    expect(movePage(pages, 0, 99).map(({ id }) => id)).toEqual(['a2', 'a3', 'a1']);
    expect(movePage(pages, 2, -10).map(({ id }) => id)).toEqual(['a3', 'a1', 'a2']);
    expect(movePage(pages, 1, 1)).toBe(pages);
  });

  it('rotates source pages with wrap-around and swaps blank dimensions', () => {
    const left = rotatePage(pages, 0, 'left');
    expect(left[0]).toMatchObject({ turns: 3 });
    expect(rotatePage(left, 0, 'right')[0]).toMatchObject({ turns: 0 });
    const blank: OrganizeEntry = { id: 'blank', kind: 'blank', widthPt: 300, heightPt: 400, turns: 0 };
    expect(rotatePage([blank], 0, 'right')[0]).toEqual({
      id: 'blank', kind: 'blank', widthPt: 400, heightPt: 300, turns: 0,
    });
  });

  it('removes, duplicates and inserts pages without mutating the input', () => {
    expect(removePage(pages, 1).map(({ id }) => id)).toEqual(['a1', 'a3']);
    expect(removePage([pages[0]!], 0)).toEqual([]);
    const turned = rotatePage(pages, 0, 'right');
    const duplicated = duplicatePage(turned, 0, ids('copy'));
    expect(duplicated[1]).toEqual({ ...turned[0]!, id: 'copy' });
    const inserted = insertBlankAfter(pages, 1, { w: 500, h: 300 }, ids('blank'));
    expect(inserted[2]).toEqual({ id: 'blank', kind: 'blank', widthPt: 500, heightPt: 300, turns: 0 });
    expect(pages).toHaveLength(3);
  });

  it('reconciles added and removed files while keeping the edited order', () => {
    const moved = movePage(pages, 2, 0);
    const withBlank = insertBlankAfter(moved, 0, { w: 300, h: 400 }, ids('blank'));
    const added = reconcilePlan(withBlank, [{ key: 'a', pageCount: 3 }, { key: 'b', pageCount: 2 }], ids('b1', 'b2'));
    expect(added.slice(0, 4)).toEqual(withBlank);
    expect(added.slice(4)).toEqual([
      { id: 'b1', kind: 'page', fileKey: 'b', pageIndex: 0, turns: 0 },
      { id: 'b2', kind: 'page', fileKey: 'b', pageIndex: 1, turns: 0 },
    ]);
    const removed = reconcilePlan(added, [{ key: 'b', pageCount: 2 }], ids());
    expect(removed.map((entry) => entry.kind === 'page' ? entry.fileKey : entry.kind)).toEqual(['blank', 'b', 'b']);
  });

  it('recognizes only the exact unchanged multi-file plan', () => {
    const files = [{ key: 'a', pageCount: 3 }, { key: 'b', pageCount: 1 }];
    const identity = [...pages, ...createEntries('b', 1, ids('b1'))];
    expect(isIdentityPlan(identity, files)).toBe(true);
    expect(isIdentityPlan(movePage(identity, 3, 0), files)).toBe(false);
    expect(isIdentityPlan(rotatePage(identity, 0, 'right'), files)).toBe(false);
    expect(isIdentityPlan(duplicatePage(identity, 0, ids('copy')), files)).toBe(false);
    expect(isIdentityPlan(removePage(identity, 3), files)).toBe(false);
  });

  it('parses valid JSON entries and drops malformed ones', () => {
    const blank = { id: 'blank', kind: 'blank', widthPt: 300, heightPt: 400, turns: 0 };
    expect(parsePlan([pages[0], blank, null, { ...pages[1], turns: 4 }, { ...blank, widthPt: -1 }]))
      .toEqual([pages[0], blank]);
    expect(parsePlan('not a plan')).toEqual([]);
  });

  it('rejects invalid source positions and blank sizes', () => {
    expect(() => movePage(pages, -1, 0)).toThrow(RangeError);
    expect(() => rotatePage(pages, 10, 'right')).toThrow(RangeError);
    expect(() => duplicatePage(pages, 10, ids())).toThrow(RangeError);
    expect(() => insertBlankAfter(pages, 0, { w: 0, h: 10 }, ids())).toThrow(RangeError);
  });
});
