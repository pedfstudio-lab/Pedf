import { describe, expect, it } from 'vitest';
import type { Edit, ImageEdit } from '@/lib/export/types';
import type { PagePlan } from './pagePlan';
import {
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  historyReducer,
} from './editsStore';

function coverEdit(id: string, pageIndex = 0): Edit {
  return {
    id,
    kind: 'cover',
    pageIndex,
    rect: { x: 10, y: 20, w: 30, h: 40 },
    z: 1,
    sampleBackground: true,
  };
}

const plan: PagePlan = [
  { id: 'page-0', kind: 'source', sourceIndex: 0 },
  { id: 'page-1', kind: 'source', sourceIndex: 1 },
];

const freshHistory = () => historyReducer(EMPTY_HISTORY, { type: 'reset-document', plan });

describe('historyReducer', () => {
  it('undoes and redoes an added edit without changing the page plan', () => {
    const initial = freshHistory();
    const edit = coverEdit('first');
    const added = historyReducer(initial, { type: 'add', edits: [edit] });

    expect(added.present).toEqual({ edits: [edit], plan });
    expect(added.past).toHaveLength(1);

    const undone = historyReducer(added, { type: 'undo' });
    expect(undone.present).toEqual({ edits: [], plan });
    expect(undone.future).toEqual([{ edits: [edit], plan }]);

    const redone = historyReducer(undone, { type: 'redo' });
    expect(redone.present).toEqual({ edits: [edit], plan });
    expect(redone.future).toEqual([]);
  });

  it('steps backward in reverse order and forward in edit order', () => {
    const edits = [coverEdit('first'), coverEdit('second'), coverEdit('third')];
    let state = freshHistory();
    for (const edit of edits) state = historyReducer(state, { type: 'add', edits: [edit] });

    state = historyReducer(state, { type: 'undo' });
    expect(state.present.edits.map(({ id }) => id)).toEqual(['first', 'second']);
    state = historyReducer(state, { type: 'undo' });
    expect(state.present.edits.map(({ id }) => id)).toEqual(['first']);
    state = historyReducer(state, { type: 'redo' });
    expect(state.present.edits.map(({ id }) => id)).toEqual(['first', 'second']);
    state = historyReducer(state, { type: 'redo' });
    expect(state.present.edits.map(({ id }) => id)).toEqual(['first', 'second', 'third']);
  });

  it('clears the redo future when a new edit follows undo', () => {
    const initial = freshHistory();
    const first = historyReducer(initial, { type: 'add', edits: [coverEdit('first')] });
    const second = historyReducer(first, { type: 'add', edits: [coverEdit('second')] });
    const undone = historyReducer(second, { type: 'undo' });
    const branched = historyReducer(undone, { type: 'add', edits: [coverEdit('replacement')] });

    expect(branched.present.edits.map(({ id }) => id)).toEqual(['first', 'replacement']);
    expect(branched.future).toEqual([]);
  });

  it('replaces a placed image without removing its existing cover or changing geometry', () => {
    const cover = coverEdit('image-cover');
    const original: ImageEdit = {
      id: 'old-image',
      kind: 'image',
      pageIndex: 0,
      rect: { x: 15, y: 25, w: 120, h: 60 },
      z: 2,
      bytes: new Uint8Array([1]),
    };
    const replacement: ImageEdit = {
      ...original,
      id: 'new-image',
      bytes: new Uint8Array([2]),
    };
    const withImage = historyReducer(freshHistory(), {
      type: 'add',
      edits: [cover, original],
    });

    const replaced = historyReducer(withImage, {
      type: 'replace',
      removeIds: [original.id],
      edits: [replacement],
    });

    expect(replaced.present.edits).toEqual([cover, replacement]);
    expect(replacement.rect).toEqual(original.rect);
    expect(replacement.z).toBe(original.z);
  });

  it('undoes and redoes a duplicate together with cloned and shifted edits', () => {
    let state = freshHistory();
    state = historyReducer(state, {
      type: 'add',
      edits: [coverEdit('first-page', 0), coverEdit('second-page', 1)],
    });
    const beforeDuplicate = state.present;
    state = historyReducer(state, { type: 'duplicate-page', position: 0, seed: 'duplicate' });

    expect(state.present.plan).toEqual([
      plan[0],
      { id: 'duplicate-0', kind: 'source', sourceIndex: 0 },
      plan[1],
    ]);
    expect(state.present.edits.map(({ id, pageIndex }) => [id, pageIndex])).toEqual([
      ['first-page', 0],
      ['second-page', 2],
      ['duplicate-1', 1],
    ]);

    state = historyReducer(state, { type: 'undo' });
    expect(state.present).toBe(beforeDuplicate);
    state = historyReducer(state, { type: 'redo' });
    expect(state.present.plan).toHaveLength(3);
    expect(state.present.edits).toHaveLength(3);
  });

  it('undoes an inserted blank and its edit-index shifts atomically', () => {
    let state = freshHistory();
    state = historyReducer(state, { type: 'add', edits: [coverEdit('second-page', 1)] });
    const beforeInsert = state.present;
    state = historyReducer(state, {
      type: 'insert-blank-page',
      position: 0,
      size: { widthPt: 300, heightPt: 400 },
      seed: 'insert',
    });
    expect(state.present.plan[1]).toEqual({
      id: 'insert-0',
      kind: 'blank',
      widthPt: 300,
      heightPt: 400,
    });
    expect(state.present.edits[0]?.pageIndex).toBe(2);

    state = historyReducer(state, { type: 'undo' });
    expect(state.present).toBe(beforeInsert);
  });

  it('undoes and redoes a delete together with removed and shifted edits', () => {
    let state = freshHistory();
    state = historyReducer(state, {
      type: 'add',
      edits: [coverEdit('deleted-page', 0), coverEdit('later-page', 1)],
    });
    const beforeDelete = state.present;
    state = historyReducer(state, { type: 'delete-page', position: 0 });

    expect(state.present.plan).toEqual([plan[1]]);
    expect(state.present.edits).toEqual([coverEdit('later-page', 0)]);

    state = historyReducer(state, { type: 'undo' });
    expect(state.present).toBe(beforeDelete);
    state = historyReducer(state, { type: 'redo' });
    expect(state.present.plan).toEqual([plan[1]]);
    expect(state.present.edits).toEqual([coverEdit('later-page', 0)]);
  });

  it('treats deleting the last remaining page as a reducer no-op', () => {
    const onlyPlan: PagePlan = [{ id: 'only-page', kind: 'source', sourceIndex: 0 }];
    const state = historyReducer(EMPTY_HISTORY, { type: 'reset-document', plan: onlyPlan });
    expect(historyReducer(state, { type: 'delete-page', position: 0 })).toBe(state);
  });

  it('returns the same state when undo or redo has nowhere to go', () => {
    const state = freshHistory();
    expect(historyReducer(state, { type: 'undo' })).toBe(state);
    expect(historyReducer(state, { type: 'redo' })).toBe(state);
  });

  it('resetting a document clears edits, past, and future and installs its plan', () => {
    const added = historyReducer(freshHistory(), { type: 'add', edits: [coverEdit('first')] });
    const undone = historyReducer(added, { type: 'undo' });
    const replacement: PagePlan = [{ id: 'replacement', kind: 'source', sourceIndex: 0 }];

    expect(historyReducer(undone, { type: 'reset-document', plan: replacement })).toEqual({
      past: [],
      present: { edits: [], plan: replacement },
      future: [],
    });
  });

  it('caps retained history snapshots at the configured limit', () => {
    let state = freshHistory();
    for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
      state = historyReducer(state, { type: 'add', edits: [coverEdit(String(index))] });
    }

    expect(state.past).toHaveLength(HISTORY_LIMIT);
    for (let index = 0; index < HISTORY_LIMIT; index += 1) {
      state = historyReducer(state, { type: 'undo' });
    }
    expect(state.present.edits).toHaveLength(5);
  });
});
