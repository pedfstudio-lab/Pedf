// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryState } from '@/state/editsStore';
import { MemoryProjectStore } from './projectStore';
import { serializeProject } from './projectState';
import { useProjectAutosave } from './useProjectAutosave';
import type { CreateProjectResult, SaveOutcome } from './useProjectAutosave';

const baseHistory: HistoryState = {
  past: [],
  present: {
    edits: [],
    plan: [{ id: 'page', kind: 'source', sourceIndex: 0 }],
  },
  future: [],
};

function historyWithPages(pageCount: number): HistoryState {
  return {
    past: [],
    present: {
      edits: [],
      plan: Array.from({ length: pageCount }, (_, sourceIndex) => ({
        id: `page-${sourceIndex}`,
        kind: 'source' as const,
        sourceIndex,
      })),
    },
    future: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function preparedStore() {
  const store = new MemoryProjectStore();
  await store.create({
    id: 'project',
    fileName: 'Contract.pdf',
    fileSize: 3,
    sha256: 'hash',
    pageCount: 1,
    lastPage: 0,
    zoom: 1,
    changeCount: 0,
    original: new Blob(['pdf']),
    state: serializeProject(baseHistory, 0, 1),
  });
  return store;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useProjectAutosave', () => {
  it('debounces several quick revisions into one state write', async () => {
    const store = await preparedStore();
    const saveState = vi.spyOn(store, 'saveState');
    const createProject = vi.fn();
    const { rerender } = renderHook(
      ({ revision }) => useProjectAutosave({
        projectId: 'project',
        initialSavedAt: 1,
        documentKey: 'document',
        snapshot: { history: baseHistory, revision, pageCount: 1, lastPage: 0, zoom: 1, changeCount: revision },
        store,
        hasChanges: true,
        createProject,
        isDraftOpen: () => false,
      }),
      { initialProps: { revision: 0 } },
    );

    rerender({ revision: 1 });
    rerender({ revision: 2 });
    rerender({ revision: 3 });
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(saveState).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenLastCalledWith(
      'project',
      expect.objectContaining({ formatVersion: 1 }),
      expect.objectContaining({ changeCount: 3 }),
    );
  });

  it('flushes changed state on pagehide', async () => {
    const store = await preparedStore();
    const saveState = vi.spyOn(store, 'saveState');
    const createProject = vi.fn();
    const { rerender } = renderHook(
      ({ revision }) => useProjectAutosave({
        projectId: 'project',
        documentKey: 'document',
        snapshot: { history: baseHistory, revision, pageCount: 1, lastPage: 0, zoom: 1, changeCount: revision },
        store,
        hasChanges: true,
        createProject,
        isDraftOpen: () => false,
      }),
      { initialProps: { revision: 0 } },
    );
    rerender({ revision: 1 });

    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      await Promise.resolve();
    });

    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it('does not save while a text draft is open and saves after it closes', async () => {
    const store = await preparedStore();
    const saveState = vi.spyOn(store, 'saveState');
    let draftOpen = true;
    const createProject = vi.fn();
    const { rerender } = renderHook(
      ({ revision }) => useProjectAutosave({
        projectId: 'project',
        documentKey: 'document',
        snapshot: { history: baseHistory, revision, pageCount: 1, lastPage: 0, zoom: 1, changeCount: revision },
        store,
        hasChanges: true,
        createProject,
        isDraftOpen: () => draftOpen,
      }),
      { initialProps: { revision: 0 } },
    );
    rerender({ revision: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(saveState).not.toHaveBeenCalled();

    draftOpen = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it('reports what an explicit save achieved', async () => {
    const store = await preparedStore();
    const createProject = vi.fn();
    const { result, rerender } = renderHook(
      ({ revision }) => useProjectAutosave({
        projectId: 'project',
        documentKey: 'document',
        snapshot: { history: baseHistory, revision, pageCount: 1, lastPage: 0, zoom: 1, changeCount: revision },
        store,
        hasChanges: true,
        createProject,
        isDraftOpen: () => false,
      }),
      { initialProps: { revision: 0 } },
    );

    await expect(result.current.saveNow()).resolves.toBe('saved');

    vi.spyOn(store, 'saveState').mockResolvedValueOnce({ status: 'full' });
    rerender({ revision: 1 });
    let outcome: string | undefined;
    await act(async () => { outcome = await result.current.saveNow(); });
    expect(outcome).toBe('full');
    expect(result.current.status).toBe('full');

    await act(async () => { outcome = await result.current.saveNow(); });
    expect(outcome).toBe('saved');
    expect(result.current.status).toBe('saved');
  });

  it('does not create an unchanged project, even on pagehide, and reports no changes', async () => {
    const store = new MemoryProjectStore();
    const createProject = vi.fn(async () => ({ outcome: 'saved' as const, projectId: 'project' }));
    const { result } = renderHook(() => useProjectAutosave({
      documentKey: 'document',
      snapshot: { history: baseHistory, revision: 0, pageCount: 1, lastPage: 0, zoom: 1, changeCount: 0 },
      store,
      hasChanges: false,
      createProject,
      isDraftOpen: () => false,
    }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      await Promise.resolve();
    });

    expect(createProject).not.toHaveBeenCalled();
    await expect(result.current.saveNow()).resolves.toBe('no-changes');
  });

  it('debounces the first real change into one project creation and flushes it on pagehide', async () => {
    const store = new MemoryProjectStore();
    const createProject = vi.fn(async () => ({ outcome: 'saved' as const, projectId: 'project' }));
    const { rerender } = renderHook(
      ({ revision, hasChanges }) => useProjectAutosave({
        documentKey: 'document',
        snapshot: { history: baseHistory, revision, pageCount: 1, lastPage: 0, zoom: 1, changeCount: revision },
        store,
        hasChanges,
        createProject,
        isDraftOpen: () => false,
      }),
      { initialProps: { revision: 0, hasChanges: false } },
    );

    rerender({ revision: 1, hasChanges: true });
    rerender({ revision: 2, hasChanges: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(createProject).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(createProject).toHaveBeenCalledTimes(1);

    const secondCreate = vi.fn(async () => ({ outcome: 'saved' as const, projectId: 'second' }));
    const second = renderHook(
      ({ hasChanges }) => useProjectAutosave({
        documentKey: 'second-document',
        snapshot: { history: baseHistory, revision: 1, pageCount: 1, lastPage: 0, zoom: 1, changeCount: 1 },
        store,
        hasChanges,
        createProject: secondCreate,
        isDraftOpen: () => false,
      }),
      { initialProps: { hasChanges: false } },
    );
    second.rerender({ hasChanges: true });
    await act(async () => {
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      await Promise.resolve();
    });
    expect(secondCreate).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  it('waits for an open text draft before creating the first save', async () => {
    const store = new MemoryProjectStore();
    const createProject = vi.fn(async () => ({ outcome: 'saved' as const, projectId: 'project' }));
    let draftOpen = true;
    renderHook(() => useProjectAutosave({
      documentKey: 'document',
      snapshot: { history: baseHistory, revision: 1, pageCount: 1, lastPage: 0, zoom: 1, changeCount: 1 },
      store,
      hasChanges: true,
      createProject,
      isDraftOpen: () => draftOpen,
    }));

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(createProject).not.toHaveBeenCalled();
    draftOpen = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(createProject).toHaveBeenCalledTimes(1);
  });

  it('retries a failed creation only after another document change', async () => {
    const store = new MemoryProjectStore();
    const createProject = vi.fn()
      .mockResolvedValueOnce({ outcome: 'full' as const })
      .mockResolvedValueOnce({ outcome: 'saved' as const, projectId: 'project' });
    const { rerender } = renderHook(
      ({ revision }) => useProjectAutosave({
        documentKey: 'document',
        snapshot: { history: baseHistory, revision, pageCount: 1, lastPage: 0, zoom: 1, changeCount: revision },
        store,
        hasChanges: true,
        createProject,
        isDraftOpen: () => false,
      }),
      { initialProps: { revision: 1 } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(createProject).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(createProject).toHaveBeenCalledTimes(1);
    rerender({ revision: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(createProject).toHaveBeenCalledTimes(2);
  });

  it('switches from one creation to saveState after the project id arrives', async () => {
    const store = await preparedStore();
    const createProject = vi.fn(async () => ({ outcome: 'saved' as const, projectId: 'project' }));
    const saveState = vi.spyOn(store, 'saveState');
    const { rerender } = renderHook(
      ({ projectId, revision }) => useProjectAutosave({
        projectId,
        documentKey: 'document',
        snapshot: { history: baseHistory, revision, pageCount: 1, lastPage: 0, zoom: 1, changeCount: revision },
        store,
        hasChanges: true,
        createProject,
        isDraftOpen: () => false,
      }),
      { initialProps: { projectId: undefined as string | undefined, revision: 1 } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(createProject).toHaveBeenCalledTimes(1);
    rerender({ projectId: 'project', revision: 1 });
    rerender({ projectId: 'project', revision: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(createProject).toHaveBeenCalledTimes(1);
    expect(saveState).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight create and stores a newer state before saveNow resolves', async () => {
    const store = await preparedStore();
    const saveState = vi.spyOn(store, 'saveState');
    const creation = deferred<CreateProjectResult>();
    const createProject = vi.fn(() => creation.promise);
    const { result, rerender } = renderHook(
      ({ revision, pages }) => useProjectAutosave({
        documentKey: 'document',
        snapshot: {
          history: historyWithPages(pages),
          revision,
          pageCount: pages,
          lastPage: 0,
          zoom: 1,
          changeCount: revision,
        },
        store,
        hasChanges: true,
        createProject,
        isDraftOpen: () => false,
      }),
      { initialProps: { revision: 1, pages: 1 } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(createProject).toHaveBeenCalledTimes(1);
    rerender({ revision: 2, pages: 2 });

    let saving!: Promise<SaveOutcome>;
    act(() => { saving = result.current.saveNow(); });
    expect(saveState).not.toHaveBeenCalled();
    let outcome: SaveOutcome | undefined;
    await act(async () => {
      creation.resolve({ outcome: 'saved', projectId: 'project' });
      outcome = await saving;
    });

    expect(outcome).toBe('saved');
    expect(saveState).toHaveBeenCalledTimes(1);
    const saveCall = saveState.mock.calls[0];
    if (!saveCall) throw new Error('Expected the newer state to be saved');
    expect(saveCall[0]).toBe('project');
    expect(saveCall[1].history.present.plan).toHaveLength(2);
    expect(saveCall[2]).toEqual(expect.objectContaining({ changeCount: 2 }));
  });

  it('uses the created id before the projectId prop reaches the hook', async () => {
    const store = await preparedStore();
    const saveState = vi.spyOn(store, 'saveState');
    const creation = deferred<CreateProjectResult>();
    const createProject = vi.fn(() => creation.promise);
    const { result, rerender } = renderHook(
      ({ revision, pages }) => useProjectAutosave({
        documentKey: 'document',
        snapshot: {
          history: historyWithPages(pages),
          revision,
          pageCount: pages,
          lastPage: 0,
          zoom: 1,
          changeCount: revision,
        },
        store,
        hasChanges: true,
        createProject,
        isDraftOpen: () => false,
      }),
      { initialProps: { revision: 1, pages: 1 } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => {
      creation.resolve({ outcome: 'saved', projectId: 'project' });
      await creation.promise;
    });
    rerender({ revision: 2, pages: 2 });

    let outcome: SaveOutcome | undefined;
    await act(async () => { outcome = await result.current.saveNow(); });
    expect(outcome).toBe('saved');
    expect(saveState).toHaveBeenCalledTimes(1);
    const saveCall = saveState.mock.calls[0];
    if (!saveCall) throw new Error('Expected the created project id to be used');
    expect(saveCall[0]).toBe('project');
    expect(saveCall[1].history.present.plan).toHaveLength(2);
  });

  it('does not adopt a created id after the open document changes', async () => {
    const store = await preparedStore();
    const saveState = vi.spyOn(store, 'saveState');
    const creation = deferred<CreateProjectResult>();
    const createProject = vi.fn()
      .mockImplementationOnce(() => creation.promise)
      .mockResolvedValueOnce({ outcome: 'saved' as const, projectId: 'next-project' });
    const { result, rerender } = renderHook(
      ({ documentKey, revision, hasChanges }) => useProjectAutosave({
        documentKey,
        snapshot: {
          history: baseHistory,
          revision,
          pageCount: 1,
          lastPage: 0,
          zoom: 1,
          changeCount: revision,
        },
        store,
        hasChanges,
        createProject,
        isDraftOpen: () => false,
      }),
      { initialProps: { documentKey: 'first', revision: 1, hasChanges: true } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    rerender({ documentKey: 'second', revision: 0, hasChanges: false });
    await act(async () => {
      creation.resolve({ outcome: 'saved', projectId: 'project' });
      await creation.promise;
    });
    expect(saveState).not.toHaveBeenCalled();

    rerender({ documentKey: 'second', revision: 1, hasChanges: true });
    let outcome: SaveOutcome | undefined;
    await act(async () => { outcome = await result.current.saveNow(); });
    expect(outcome).toBe('saved');
    expect(createProject).toHaveBeenCalledTimes(2);
    expect(saveState).not.toHaveBeenCalled();
  });

  it.each(['full', 'unavailable'] as const)(
    'returns %s when an in-flight create fails while saveNow waits',
    async (failure) => {
      const store = new MemoryProjectStore();
      const creation = deferred<CreateProjectResult>();
      const createProject = vi.fn(() => creation.promise);
      const { result } = renderHook(() => useProjectAutosave({
        documentKey: 'document',
        snapshot: { history: baseHistory, revision: 1, pageCount: 1, lastPage: 0, zoom: 1, changeCount: 1 },
        store,
        hasChanges: true,
        createProject,
        isDraftOpen: () => false,
      }));

      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      let saving!: Promise<SaveOutcome>;
      act(() => { saving = result.current.saveNow(); });
      let outcome: SaveOutcome | undefined;
      await act(async () => {
        creation.resolve({ outcome: failure });
        outcome = await saving;
      });
      expect(outcome).toBe(failure);
    },
  );
});
