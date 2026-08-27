import { describe, expect, it } from 'vitest';
import type { Edit } from '@/lib/export/types';
import type { PageGeometry } from '@/lib/pdf/types';
import {
  createPagePlan,
  deletePage,
  duplicatePage,
  insertBlankPage,
  isIdentityPagePlan,
  planToGeometry,
} from './pagePlan';

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}

function edit(id: string, pageIndex: number): Edit {
  return {
    id,
    kind: 'cover',
    pageIndex,
    rect: { x: 10, y: 20, w: 30, h: 40 },
    z: 1,
    sampleBackground: true,
  };
}

const geometry: PageGeometry[] = [
  { pageIndex: 0, widthPt: 300, heightPt: 400, rotation: 0, boxOffset: { x: 0, y: 0 } },
  { pageIndex: 1, widthPt: 500, heightPt: 600, rotation: 90, boxOffset: { x: 5, y: 7 } },
  { pageIndex: 2, widthPt: 700, heightPt: 800, rotation: 0, boxOffset: { x: 0, y: 0 } },
];

describe('page plan operations', () => {
  it('duplicates a source page, clones its edits, and shifts later edits', () => {
    const plan = createPagePlan(3, ids('page-0', 'page-1', 'page-2'));
    const result = duplicatePage(
      plan,
      [edit('above', 0), edit('on-page', 1), edit('below', 2)],
      1,
      ids('copy-page', 'copy-edit'),
    );

    expect(result.plan).toHaveLength(4);
    expect(result.plan[2]).toEqual({ id: 'copy-page', kind: 'source', sourceIndex: 1 });
    expect(result.edits).toEqual([
      edit('above', 0),
      edit('on-page', 1),
      edit('below', 3),
      edit('copy-edit', 2),
    ]);
  });

  it('inserts a same-size blank and shifts later edits without cloning', () => {
    const plan = createPagePlan(3, ids('page-0', 'page-1', 'page-2'));
    const result = insertBlankPage(
      plan,
      [edit('on-page', 1), edit('below', 2)],
      1,
      { widthPt: 500, heightPt: 600 },
      ids('blank-page'),
    );

    expect(result.plan[2]).toEqual({
      id: 'blank-page',
      kind: 'blank',
      widthPt: 500,
      heightPt: 600,
    });
    expect(result.edits).toEqual([edit('on-page', 1), edit('below', 3)]);
  });

  it('deletes a page, drops its edits, and pulls later edits back', () => {
    const plan = createPagePlan(3, ids('page-0', 'page-1', 'page-2'));
    const result = deletePage(
      plan,
      [edit('above', 0), edit('on-page', 1), edit('below', 2)],
      1,
    );

    expect(result.plan).toEqual([plan[0], plan[2]]);
    expect(result.edits).toEqual([edit('above', 0), edit('below', 1)]);
  });

  it('refuses to delete the only remaining page', () => {
    const plan = createPagePlan(1, ids('only-page'));
    expect(() => deletePage(plan, [edit('only-edit', 0)], 0))
      .toThrow('cannot delete the last remaining page');
  });

  it('composes multiple operations without losing the positional index invariant', () => {
    const initial = createPagePlan(2, ids('page-0', 'page-1'));
    const duplicated = duplicatePage(initial, [edit('second', 1)], 1, ids('copy', 'copy-edit'));
    const inserted = insertBlankPage(
      duplicated.plan,
      duplicated.edits,
      0,
      { widthPt: 300, heightPt: 400 },
      ids('blank'),
    );

    expect(inserted.plan.map((entry) => entry.kind)).toEqual([
      'source',
      'blank',
      'source',
      'source',
    ]);
    expect(inserted.edits.map(({ id, pageIndex }) => [id, pageIndex])).toEqual([
      ['second', 2],
      ['copy-edit', 3],
    ]);
    expect(planToGeometry(inserted.plan, geometry).map(({ pageIndex }) => pageIndex))
      .toEqual([0, 1, 2, 3]);

    const deleted = deletePage(inserted.plan, inserted.edits, 2);
    expect(deleted.plan.map((entry) => entry.kind)).toEqual(['source', 'blank', 'source']);
    expect(deleted.edits.map(({ id, pageIndex }) => [id, pageIndex]))
      .toEqual([['copy-edit', 2]]);
  });

  it('derives source and blank geometry and recognizes only identity plans', () => {
    const identity = createPagePlan(3, ids('page-0', 'page-1', 'page-2'));
    expect(isIdentityPagePlan(identity, 3)).toBe(true);
    expect(isIdentityPagePlan(undefined, 3)).toBe(true);

    const inserted = insertBlankPage(
      identity,
      [],
      0,
      { widthPt: 300, heightPt: 400 },
      ids('blank'),
    ).plan;
    expect(isIdentityPagePlan(inserted, 3)).toBe(false);
    expect(planToGeometry(inserted, geometry)).toEqual([
      geometry[0],
      { pageIndex: 1, widthPt: 300, heightPt: 400, rotation: 0, boxOffset: { x: 0, y: 0 } },
      { ...geometry[1], pageIndex: 2 },
      { ...geometry[2], pageIndex: 3 },
    ]);
  });
});
