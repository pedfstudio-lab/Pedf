// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HistoryState } from '@/state/editsStore';
import { MemoryProjectStore } from '@/lib/projects/projectStore';
import { serializeProject } from '@/lib/projects/projectState';
import { savedAgo } from '@/lib/projects/savedTime';
import { ContinueEditingCard } from './ContinueEditingCard';

const history: HistoryState = {
  past: [],
  present: {
    edits: [],
    plan: [{ id: 'page', kind: 'source', sourceIndex: 0 }],
  },
  future: [],
};

async function addProject(
  store: MemoryProjectStore,
  id: string,
  lastPage: number,
  changeCount: number,
  pageCount = 100,
) {
  await store.create({
    id,
    fileName: `${id}.pdf`,
    fileSize: 100,
    sha256: id,
    pageCount,
    lastPage,
    zoom: 1,
    changeCount,
    original: new Blob(['pdf']),
    state: serializeProject(history, 0, 1),
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ContinueEditingCard', () => {
  it('shows the newest save with time, page, changes, and the other files', async () => {
    let now = Date.now() - 12 * 60_000;
    const store = new MemoryProjectStore(() => now++);
    await addProject(store, 'older', 2, 4);
    await addProject(store, 'Contract', 12, 27);

    render(<ContinueEditingCard store={store} onContinue={() => true} />);

    expect(await screen.findByText('Contract.pdf')).toBeTruthy();
    expect(screen.getByText(/page 13 of 100 · 27 changes/)).toBeTruthy();
    fireEvent.click(screen.getByText('Other saved files'));
    expect(screen.getByText('older.pdf')).toBeTruthy();
  });

  it('continues valid saves and confirms before deleting one', async () => {
    const store = new MemoryProjectStore();
    await addProject(store, 'Contract', 0, 1);
    const onContinue = vi.fn(() => true);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ContinueEditingCard store={store} onContinue={onContinue} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Continue editing' }));
    await waitFor(() => expect(onContinue).toHaveBeenCalledWith('Contract'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete saved file' }));
    await waitFor(() => expect(screen.queryByLabelText('Saved PDF projects')).toBeNull());
    expect(window.confirm).toHaveBeenCalledWith(
      "Delete the saved edits for Contract.pdf? This can't be undone.",
    );
  });

  it('shows the current page total and singular or plural user-action count', async () => {
    let now = 100;
    const store = new MemoryProjectStore(() => now++);
    await addProject(store, 'Duplicated', 0, 2, 10);
    await addProject(store, 'Heading', 0, 1, 8);

    render(<ContinueEditingCard store={store} onContinue={() => true} />);

    expect(await screen.findByText(/page 1 of 8 · 1 change$/)).toBeTruthy();
    fireEvent.click(screen.getByText('Other saved files'));
    expect(screen.getByText(/page 1 of 10 · 2 changes$/)).toBeTruthy();
  });

  it('reports a missing project instead of throwing', async () => {
    const store = new MemoryProjectStore();
    await addProject(store, 'Missing', 0, 0);
    render(<ContinueEditingCard store={store} onContinue={() => true} />);
    await screen.findByText('Missing.pdf');
    vi.spyOn(store, 'load').mockResolvedValue({ status: 'ok', value: undefined });

    fireEvent.click(screen.getByRole('button', { name: 'Continue editing' }));

    expect(await screen.findByText("This saved file can't be opened.")).toBeTruthy();
  });

  it('updates when the shared project store notifies', async () => {
    const store = new MemoryProjectStore();
    render(<ContinueEditingCard store={store} onContinue={() => true} />);
    expect(screen.queryByLabelText('Saved PDF projects')).toBeNull();

    await act(async () => { await addProject(store, 'New-save', 0, 1); });

    expect(await screen.findByText('New-save.pdf')).toBeTruthy();
  });
});

it('formats saved time in quiet human units', () => {
  const now = 10_000_000;
  expect(savedAgo(now - 30_000, now)).toBe('just now');
  expect(savedAgo(now - 2 * 60_000, now)).toBe('2 min ago');
  expect(savedAgo(now - 2 * 60 * 60_000, now)).toBe('2 hours ago');
});
