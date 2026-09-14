import { describe, expect, it, vi } from 'vitest';
import type { HistoryState } from '@/state/editsStore';
import { MemoryProjectStore } from './projectStore';
import type { CreateProjectInput } from './projectStore';
import { serializeProject } from './projectState';

const history: HistoryState = {
  past: [],
  present: {
    edits: [],
    plan: [{ id: 'page-0', kind: 'source', sourceIndex: 0 }],
  },
  future: [],
};

function input(id: string, original = new Uint8Array([1, 2, 3])): CreateProjectInput {
  return {
    id,
    fileName: `${id}.pdf`,
    fileSize: original.byteLength,
    sha256: `hash-${id}`,
    pageCount: 1,
    lastPage: 0,
    zoom: 1,
    changeCount: 0,
    original: new Blob([original.slice().buffer], { type: 'application/pdf' }),
    state: serializeProject(history, 0, 1),
  };
}

describe('MemoryProjectStore', () => {
  it('writes the original once and saveState only replaces state and progress', async () => {
    let time = 100;
    const store = new MemoryProjectStore(() => time++);
    expect((await store.create(input('one'))).status).toBe('ok');
    const nextHistory: HistoryState = {
      ...history,
      present: {
        ...history.present,
        edits: [{
          id: 'cover',
          kind: 'cover',
          pageIndex: 0,
          rect: { x: 1, y: 2, w: 3, h: 4 },
          z: 1,
          sampleBackground: true,
        }],
      },
    };
    expect((await store.saveState('one', serializeProject(nextHistory, 0, 1.25), {
      pageCount: 2,
      lastPage: 0,
      zoom: 1.25,
      changeCount: 1,
    })).status).toBe('ok');

    const loaded = await store.load('one');
    expect(loaded.status).toBe('ok');
    if (loaded.status !== 'ok' || !loaded.value) return;
    expect(new Uint8Array(await loaded.value.original.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(loaded.value.state.history.present.edits).toHaveLength(1);
    expect(loaded.value.metadata.pageCount).toBe(2);
    expect(loaded.value.metadata.changeCount).toBe(1);
    expect(loaded.value.metadata.zoom).toBe(1.25);
    expect(store.originalWriteCount('one')).toBe(1);
  });

  it('keeps 10 projects and reports the least-recently-saved project evicted by the 11th', async () => {
    let time = 0;
    const store = new MemoryProjectStore(() => time++);
    for (let index = 0; index < 10; index += 1) await store.create(input(`project-${index}`));
    await store.saveState('project-0', input('project-0').state, {
      pageCount: 1,
      lastPage: 0,
      zoom: 1,
      changeCount: 0,
    });
    const eleventh = await store.create(input('project-10'));
    expect(eleventh).toMatchObject({
      status: 'ok',
      evicted: { id: 'project-1', fileName: 'project-1.pdf' },
    });

    const listed = await store.list();
    expect(listed.status).toBe('ok');
    if (listed.status !== 'ok') return;
    expect(listed.value).toHaveLength(10);
    expect(listed.value.map(({ id }) => id)).toEqual([
      'project-10',
      'project-0',
      'project-9',
      'project-8',
      'project-7',
      'project-6',
      'project-5',
      'project-4',
      'project-3',
      'project-2',
    ]);
    expect((await store.load('project-1'))).toEqual({ status: 'ok', value: undefined });
  });

  it('deletes one project or all projects', async () => {
    const store = new MemoryProjectStore();
    await store.create(input('one'));
    await store.create(input('two'));
    expect((await store.delete('one')).status).toBe('ok');
    const afterOne = await store.list();
    expect(afterOne.status === 'ok' ? afterOne.value.map(({ id }) => id) : []).toEqual(['two']);
    expect((await store.deleteAll()).status).toBe('ok');
    expect(await store.list()).toEqual({ status: 'ok', value: [] });
  });

  it('maps quota and other storage failures without throwing', async () => {
    const full = new MemoryProjectStore(undefined, () => ({ name: 'QuotaExceededError' }));
    const unavailable = new MemoryProjectStore(undefined, () => new Error('blocked'));

    expect(await full.create(input('full'))).toEqual({ status: 'full' });
    expect(await unavailable.create(input('blocked'))).toEqual({ status: 'unavailable' });
    expect(await unavailable.saveState('blocked', input('blocked').state, {
      pageCount: 1,
      lastPage: 0,
      zoom: 1,
      changeCount: 0,
    })).toEqual({ status: 'unavailable' });
    expect(await unavailable.load('blocked')).toEqual({ status: 'unavailable' });
    expect(await unavailable.list()).toEqual({ status: 'unavailable' });
    expect(await unavailable.delete('blocked')).toEqual({ status: 'unavailable' });
    expect(await unavailable.deleteAll()).toEqual({ status: 'unavailable' });
  });

  it('notifies subscribers after successful writes only and stops after unsubscribe', async () => {
    const store = new MemoryProjectStore(undefined, (operation) => (
      operation === 'saveState' ? new Error('blocked') : undefined
    ));
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    await store.create(input('one'));
    expect(listener).toHaveBeenCalledTimes(1);
    await store.saveState('one', input('one').state, {
      pageCount: 1,
      lastPage: 0,
      zoom: 1,
      changeCount: 0,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    await store.delete('one');
    await store.deleteAll();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    await store.create(input('two'));
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
