// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectStore } from '@/lib/projects/projectStore';
import type { CreateProjectInput } from '@/lib/projects/projectStore';
import { serializeProject } from '@/lib/projects/projectState';
import { EMPTY_HISTORY } from '@/state/editsStore';
import { SavedFilesColumn } from './SavedFilesColumn';

function input(
  id: string,
  changeCount: number,
  fileName = `${id}.pdf`,
): CreateProjectInput {
  const history = {
    ...EMPTY_HISTORY,
    present: {
      edits: [],
      plan: [{ id: 'page-0', kind: 'source' as const, sourceIndex: 0 }],
    },
  };
  return {
    id,
    fileName,
    fileSize: 3,
    sha256: id,
    pageCount: 1,
    lastPage: 0,
    zoom: 1,
    changeCount,
    original: new Blob(['pdf']),
    state: serializeProject(history, 0, 1),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SavedFilesColumn', () => {
  it('lists newest first with full-name tooltips, times, and action counts', async () => {
    let now = Date.now() - 2 * 60_000;
    const store = new MemoryProjectStore(() => now++);
    const longName = 'A very long contract filename that needs truncation.pdf';
    await store.create(input('older', 1));
    await store.create(input('newer', 4, longName));

    render(<SavedFilesColumn store={store} onOpen={vi.fn()} onHide={vi.fn()} />);

    const rows = await screen.findAllByRole('listitem');
    expect(within(rows[0]!).getByText(longName)).toBeTruthy();
    expect(within(rows[0]!).getByText(/2 min ago · 4 changes/)).toBeTruthy();
    expect(within(rows[1]!).getByText(/2 min ago · 1 change$/)).toBeTruthy();
    const longNameButton = within(rows[0]!).getByTitle(longName);
    expect(longNameButton.getAttribute('title')).toBe(longName);
    expect(longNameButton.querySelector('.truncate')).toBeTruthy();
  });

  it('opens a row, shows Opening, and disables the other rows until it finishes', async () => {
    const store = new MemoryProjectStore();
    await store.create(input('one', 1));
    await store.create(input('two', 2));
    const opening = deferred<void>();
    const onOpen = vi.fn(() => opening.promise);
    render(<SavedFilesColumn store={store} onOpen={onOpen} onHide={vi.fn()} />);
    const row = await screen.findByTitle('two.pdf');

    fireEvent.click(row);

    expect(onOpen).toHaveBeenCalledWith('two');
    expect(screen.getByText('Opening…')).toBeTruthy();
    expect((screen.getByTitle('one.pdf') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { opening.resolve(); });
    await waitFor(() => expect(screen.queryByText('Opening…')).toBeNull());
  });

  it('highlights the open file, does nothing when clicked, and prevents deleting it', async () => {
    const store = new MemoryProjectStore();
    await store.create(input('current', 3));
    const onOpen = vi.fn();
    render(
      <SavedFilesColumn
        store={store}
        currentProjectId="current"
        onOpen={onOpen}
        onHide={vi.fn()}
      />,
    );
    const row = await screen.findByTitle('current.pdf');

    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.className).not.toContain('opacity');
    fireEvent.click(row);
    expect(onOpen).not.toHaveBeenCalled();
    const more = screen.getByRole('button', { name: 'More actions for current.pdf' }) as HTMLButtonElement;
    expect(more.disabled).toBe(true);
    expect(more.title).toBe('Close this file first to delete its save');
    expect(screen.queryByRole('button', { name: 'Delete saved file' })).toBeNull();
  });

  it('confirms deletion and removes the row after the store notification', async () => {
    const store = new MemoryProjectStore();
    await store.create(input('delete-me', 2));
    const deleteProject = vi.spyOn(store, 'delete');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SavedFilesColumn store={store} onOpen={vi.fn()} onHide={vi.fn()} />);
    await screen.findByText('delete-me.pdf');

    fireEvent.click(screen.getByRole('button', { name: 'More actions for delete-me.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete saved file' }));

    await waitFor(() => expect(screen.queryByText('delete-me.pdf')).toBeNull());
    expect(deleteProject).toHaveBeenCalledWith('delete-me');
    expect(window.confirm).toHaveBeenCalledWith(
      "Delete the saved edits for delete-me.pdf? This can't be undone.",
    );
  });

  it('shows empty and unavailable states', async () => {
    const emptyStore = new MemoryProjectStore();
    const first = render(<SavedFilesColumn store={emptyStore} onOpen={vi.fn()} onHide={vi.fn()} />);
    expect(await screen.findByText('No saved files yet. Your changes save here automatically.')).toBeTruthy();
    first.unmount();

    const unavailable = new MemoryProjectStore(undefined, (operation) => (
      operation === 'list' ? new Error('blocked') : undefined
    ));
    render(<SavedFilesColumn store={unavailable} onOpen={vi.fn()} onHide={vi.fn()} />);
    expect(await screen.findByText("Can't save on this device.")).toBeTruthy();
  });

  it('calls the hide control', async () => {
    const onHide = vi.fn();
    render(<SavedFilesColumn store={new MemoryProjectStore()} onOpen={vi.fn()} onHide={onHide} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hide saved files' }));
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
