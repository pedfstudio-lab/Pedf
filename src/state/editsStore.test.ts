import { describe, expect, it } from 'vitest';
import type { Edit } from '@/lib/export/types';
import {
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  historyReducer,
} from './editsStore';

function coverEdit(id: string): Edit {
  return {
    id,
    kind: 'cover',
    pageIndex: 0,
    rect: { x: 10, y: 20, w: 30, h: 40 },
    z: 1,
    sampleBackground: true,
  };
}

describe('historyReducer', () => {
  it('undoes and redoes an added edit', () => {
    const edit = coverEdit('first');
    const added = historyReducer(EMPTY_HISTORY, { type: 'add', edits: [edit] });

    expect(added.present).toEqual([edit]);
    expect(added.past).toHaveLength(1);

    const undone = historyReducer(added, { type: 'undo' });
    expect(undone.present).toEqual([]);
    expect(undone.future).toEqual([[edit]]);

    const redone = historyReducer(undone, { type: 'redo' });
    expect(redone.present).toEqual([edit]);
    expect(redone.future).toEqual([]);
  });

  it('steps backward in reverse order and forward in edit order', () => {
    const edits = [coverEdit('first'), coverEdit('second'), coverEdit('third')];
    let state = EMPTY_HISTORY;
    for (const edit of edits) state = historyReducer(state, { type: 'add', edits: [edit] });

    state = historyReducer(state, { type: 'undo' });
    expect(state.present.map(({ id }) => id)).toEqual(['first', 'second']);
    state = historyReducer(state, { type: 'undo' });
    expect(state.present.map(({ id }) => id)).toEqual(['first']);
    state = historyReducer(state, { type: 'redo' });
    expect(state.present.map(({ id }) => id)).toEqual(['first', 'second']);
    state = historyReducer(state, { type: 'redo' });
    expect(state.present.map(({ id }) => id)).toEqual(['first', 'second', 'third']);
  });

  it('clears the redo future when a new edit follows undo', () => {
    const first = historyReducer(EMPTY_HISTORY, { type: 'add', edits: [coverEdit('first')] });
    const second = historyReducer(first, { type: 'add', edits: [coverEdit('second')] });
    const undone = historyReducer(second, { type: 'undo' });
    const branched = historyReducer(undone, { type: 'add', edits: [coverEdit('replacement')] });

    expect(branched.present.map(({ id }) => id)).toEqual(['first', 'replacement']);
    expect(branched.future).toEqual([]);
  });

  it('returns the same state when undo or redo has nowhere to go', () => {
    expect(historyReducer(EMPTY_HISTORY, { type: 'undo' })).toBe(EMPTY_HISTORY);
    expect(historyReducer(EMPTY_HISTORY, { type: 'redo' })).toBe(EMPTY_HISTORY);
  });

  it('reset clears past, present, and future', () => {
    const added = historyReducer(EMPTY_HISTORY, { type: 'add', edits: [coverEdit('first')] });
    const undone = historyReducer(added, { type: 'undo' });

    expect(historyReducer(undone, { type: 'reset' })).toBe(EMPTY_HISTORY);
  });

  it('caps retained history snapshots at the configured limit', () => {
    let state = EMPTY_HISTORY;
    for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
      state = historyReducer(state, { type: 'add', edits: [coverEdit(String(index))] });
    }

    expect(state.past).toHaveLength(HISTORY_LIMIT);
    for (let index = 0; index < HISTORY_LIMIT; index += 1) {
      state = historyReducer(state, { type: 'undo' });
    }
    expect(state.present).toHaveLength(5);
  });
});
