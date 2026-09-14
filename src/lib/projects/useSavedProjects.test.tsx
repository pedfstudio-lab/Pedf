// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectStore } from './projectStore';
import type { CreateProjectInput } from './projectStore';
import { serializeProject } from './projectState';
import { EMPTY_HISTORY } from '@/state/editsStore';
import { useSavedProjects } from './useSavedProjects';

function input(id: string): CreateProjectInput {
  const history = {
    ...EMPTY_HISTORY,
    present: {
      edits: [],
      plan: [{ id: 'page-0', kind: 'source' as const, sourceIndex: 0 }],
    },
  };
  return {
    id,
    fileName: `${id}.pdf`,
    fileSize: 3,
    sha256: id,
    pageCount: 1,
    lastPage: 0,
    zoom: 1,
    changeCount: 0,
    original: new Blob(['pdf']),
    state: serializeProject(history, 0, 1),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('useSavedProjects', () => {
  it('lists on mount and refreshes after successful writes and deletes', async () => {
    const store = new MemoryProjectStore();
    const list = vi.spyOn(store, 'list');
    const { result } = renderHook(() => useSavedProjects(store));

    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(list).toHaveBeenCalledTimes(1);

    await act(async () => { await store.create(input('one')); });
    await waitFor(() => expect(result.current.projects.map(({ id }) => id)).toEqual(['one']));

    await act(async () => {
      await store.saveState('one', input('one').state, {
        pageCount: 1,
        lastPage: 0,
        zoom: 1.25,
        changeCount: 1,
      });
    });
    await waitFor(() => expect(result.current.projects[0]?.changeCount).toBe(1));

    await act(async () => { await store.delete('one'); });
    await waitFor(() => expect(result.current.projects).toEqual([]));
    await act(async () => { await store.create(input('two')); });
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    await act(async () => { await store.deleteAll(); });
    await waitFor(() => expect(result.current.projects).toEqual([]));
  });

  it('reports unavailable when listing fails', async () => {
    const store = new MemoryProjectStore(undefined, (operation) => (
      operation === 'list' ? new Error('blocked') : undefined
    ));
    const { result } = renderHook(() => useSavedProjects(store));

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.projects).toEqual([]);
  });

  it('unsubscribes on unmount', async () => {
    const store = new MemoryProjectStore();
    const originalSubscribe = store.subscribe.bind(store);
    const unsubscribe = vi.fn();
    vi.spyOn(store, 'subscribe').mockImplementation((listener) => {
      const stop = originalSubscribe(listener);
      return () => {
        unsubscribe();
        stop();
      };
    });
    const hook = renderHook(() => useSavedProjects(store));
    await waitFor(() => expect(hook.result.current.status).toBe('ok'));

    hook.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
