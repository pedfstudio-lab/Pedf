// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryState } from './state/editsStore';
import type {
  CreateProjectInput,
  ProjectMetadata,
  StoredProject,
} from './lib/projects/projectStore';
import { serializeProject } from './lib/projects/projectState';
import { setPendingFile, takePendingFile, takePendingProject } from './lib/site/pendingFile';
import App from './App';

const mocks = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  loadDocument: vi.fn(),
  sha256Hex: vi.fn(),
  projectStore: {
    subscribe: vi.fn((listener: () => void) => {
      void listener;
      return () => undefined;
    }),
    create: vi.fn(),
    saveState: vi.fn(),
    load: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
    deleteAll: vi.fn(),
  },
}));

vi.mock('./lib/pdf/loadDocument', () => ({ loadDocument: mocks.loadDocument }));
vi.mock('./lib/projects/projectStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/projects/projectStore')>()),
  projectStore: mocks.projectStore,
  sha256Hex: mocks.sha256Hex,
}));
vi.mock('./lib/export/exportPdf', () => ({ exportPdf: vi.fn() }));
vi.mock('./components/PdfChat', () => ({ PdfChat: () => null }));
vi.mock('./components/SettingsPanel', () => ({ SettingsPanel: () => null }));
vi.mock('./components/sign/SignatureModal', () => ({ SignatureModal: () => null }));
vi.mock('./components/PdfViewer', async () => {
  const { useEffect } = await import('react');
  const { useEdits } = await import('./state/editsStore');
  return {
    PdfViewer: ({ onLayout }: { onLayout?(): void }) => {
      const { addEdits, duplicatePage } = useEdits();
      useEffect(() => onLayout?.(), [onLayout]);
      return (
        <div>
          <button
            type="button"
            onClick={() => addEdits([{
              id: 'new-cover',
              kind: 'cover',
              pageIndex: 0,
              rect: { x: 1, y: 2, w: 3, h: 4 },
              z: 1,
              sampleBackground: true,
            }])}
          >
            Make test change
          </button>
          <button type="button" onClick={() => duplicatePage(0)}>Duplicate test page</button>
          <div data-page-index="0">Page one</div>
          <div data-page-index="1">Page two</div>
        </div>
      );
    },
  };
});

const plan = [
  { id: 'page-0', kind: 'source' as const, sourceIndex: 0 },
  { id: 'page-1', kind: 'source' as const, sourceIndex: 1 },
];
const history: HistoryState = {
  past: [{ edits: [], plan }],
  present: {
    edits: [{
      id: 'cover-1',
      kind: 'cover',
      pageIndex: 1,
      rect: { x: 10, y: 20, w: 30, h: 40 },
      z: 1,
      sampleBackground: true,
    }],
    plan,
  },
  future: [],
};
const metadata: ProjectMetadata = {
  id: 'saved-project',
  fileName: 'Contract.pdf',
  fileSize: 512,
  sha256: 'same-hash',
  pageCount: 2,
  lastPage: 1,
  zoom: 1.5,
  changeCount: 1,
  createdAt: 1_000,
  updatedAt: 2_000,
  formatVersion: 1,
};
const stored: StoredProject = {
  metadata,
  original: new Blob(['%PDF-1.7']),
  state: serializeProject(history, 1, 1.5),
};
const otherMetadata: ProjectMetadata = {
  ...metadata,
  id: 'other-project',
  fileName: 'Other.pdf',
  sha256: 'other-hash',
  lastPage: 0,
  zoom: 1.25,
  changeCount: 4,
  createdAt: 3_000,
  updatedAt: 4_000,
};
const otherStored: StoredProject = {
  metadata: otherMetadata,
  original: new Blob(['%PDF-1.7 other']),
  state: serializeProject(history, 0, 1.25),
};

function notifyProjects() {
  for (const listener of mocks.listeners) listener();
}

function loadedDocument(pageCount = 2) {
  return {
    doc: { destroy: vi.fn() },
    originalBytes: new Uint8Array([1, 2, 3]),
    pages: Array.from({ length: pageCount }, (_, pageIndex) => ({
      pageIndex,
      widthPt: 612,
      heightPt: 792,
      rotation: 0,
      boxOffset: { x: 0, y: 0 },
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listeners.clear();
  mocks.projectStore.subscribe.mockImplementation((listener: () => void) => {
    mocks.listeners.add(listener);
    return () => {
      mocks.listeners.delete(listener);
    };
  });
  localStorage.clear();
  takePendingFile();
  takePendingProject();
  mocks.loadDocument.mockResolvedValue(loadedDocument());
  mocks.sha256Hex.mockResolvedValue('new-hash');
  mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [] });
  mocks.projectStore.load.mockResolvedValue({ status: 'ok', value: stored });
  mocks.projectStore.create.mockImplementation(async (input: CreateProjectInput) => ({
    status: 'ok',
    value: {
      ...metadata,
      id: 'new-project',
      fileName: input.fileName,
      sha256: input.sha256,
      pageCount: input.pageCount,
      lastPage: input.lastPage,
      zoom: input.zoom,
      changeCount: input.changeCount,
    },
  }));
  mocks.projectStore.saveState.mockResolvedValue({ status: 'ok', value: metadata });
  mocks.projectStore.delete.mockResolvedValue({ status: 'ok', value: undefined });
  mocks.projectStore.deleteAll.mockResolvedValue({ status: 'ok', value: undefined });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.dataset.pageIndex === '1' ? 200 : 0;
    return { x: 0, y: top, top, left: 0, right: 100, bottom: top + 100, width: 100, height: 100, toJSON: () => ({}) };
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  takePendingFile();
  takePendingProject();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('App saved projects', () => {
  it('opens and closes an unchanged PDF without creating a saved project', async () => {
    const file = new File(['%PDF-1.7'], 'Contract.pdf', { type: 'application/pdf' });
    setPendingFile(file);
    render(<App />);
    expect(await screen.findByText('Contract.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));

    expect(await screen.findByText('No changes to save — closed Contract.pdf.')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'PDF drop area' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save & close' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Continue editing' })).toBeNull();
    expect(mocks.projectStore.create).not.toHaveBeenCalled();
    expect(mocks.projectStore.delete).not.toHaveBeenCalled();
  });

  it('Ctrl+S reports no changes without writing an unchanged PDF', async () => {
    const file = new File(['%PDF-1.7'], 'Unchanged.pdf', { type: 'application/pdf' });
    setPendingFile(file);
    render(<App />);
    expect(await screen.findByText('Unchanged.pdf')).toBeTruthy();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }));

    expect(await screen.findByText('No changes to save')).toBeTruthy();
    expect(mocks.projectStore.create).not.toHaveBeenCalled();
  });

  it('Save & close creates the first save after a real change, closes, and offers Continue', async () => {
    const file = new File(['%PDF-1.7'], 'Contract.pdf', { type: 'application/pdf' });
    setPendingFile(file);
    render(<App />);
    expect(await screen.findByText('Contract.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make test change' }));
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [{ ...metadata, id: 'new-project' }] });

    fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));

    expect(await screen.findByText('Saved Contract.pdf on this device — continue editing anytime.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Continue editing' })).toBeTruthy();
    expect(mocks.projectStore.create).toHaveBeenCalledTimes(1);
    expect(mocks.projectStore.delete).not.toHaveBeenCalled();
  });

  it('waits for a newer change to be stored while the first project creation is in flight', async () => {
    const creation = deferred<{ status: 'ok'; value: ProjectMetadata }>();
    const stateSave = deferred<{ status: 'ok'; value: ProjectMetadata }>();
    mocks.projectStore.create.mockImplementationOnce(() => creation.promise);
    mocks.projectStore.saveState.mockImplementationOnce(() => stateSave.promise);
    setPendingFile(new File(['%PDF-1.7'], 'Slow.pdf', { type: 'application/pdf' }));
    render(<App />);
    expect(await screen.findByText('Slow.pdf')).toBeTruthy();

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Make test change' }));
    act(() => {
      vi.advanceTimersByTime(1_000);
      fireEvent.click(screen.getByRole('button', { name: 'Make test change' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));
    });
    expect(mocks.projectStore.create).toHaveBeenCalledTimes(1);

    await act(async () => {
      creation.resolve({
        status: 'ok',
        value: { ...metadata, id: 'slow-project', fileName: 'Slow.pdf', changeCount: 1 },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.projectStore.saveState).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Slow.pdf')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'PDF drop area' })).toBeNull();
    const saveCall = mocks.projectStore.saveState.mock.calls[0];
    if (!saveCall) throw new Error('Expected the newer state to be saved');
    const [, savedState, progress] = saveCall;
    expect(savedState.history.present.edits).toHaveLength(2);
    expect(progress).toMatchObject({ pageCount: 2, changeCount: 2 });

    await act(async () => {
      stateSave.resolve({
        status: 'ok',
        value: { ...metadata, id: 'slow-project', fileName: 'Slow.pdf', changeCount: 2 },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.useRealTimers();
    expect(await screen.findByText('Saved Slow.pdf on this device — continue editing anytime.')).toBeTruthy();
  });

  it('does not attach a late project creation to a replacement document', async () => {
    const firstCreation = deferred<{ status: 'ok'; value: ProjectMetadata }>();
    mocks.loadDocument
      .mockResolvedValueOnce(loadedDocument())
      .mockResolvedValueOnce(loadedDocument());
    mocks.sha256Hex
      .mockResolvedValueOnce('first-hash')
      .mockResolvedValueOnce('second-hash');
    mocks.projectStore.create
      .mockImplementationOnce(() => firstCreation.promise)
      .mockImplementationOnce(async (input: CreateProjectInput) => ({
        status: 'ok',
        value: {
          ...metadata,
          id: 'second-project',
          fileName: input.fileName,
          sha256: input.sha256,
          pageCount: input.pageCount,
          changeCount: input.changeCount,
        },
      }));
    setPendingFile(new File(['%PDF-1.7'], 'First.pdf', { type: 'application/pdf' }));
    render(<App />);
    expect(await screen.findByText('First.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make test change' }));
    await waitFor(() => expect(mocks.projectStore.create).toHaveBeenCalledTimes(1), { timeout: 2_000 });

    fireEvent.change(screen.getByLabelText('Open PDF'), {
      target: { files: [new File(['%PDF-1.7'], 'Second.pdf', { type: 'application/pdf' })] },
    });
    expect(screen.getAllByText('First.pdf').length).toBeGreaterThan(0);
    expect(mocks.loadDocument).toHaveBeenCalledTimes(1);
    await act(async () => {
      firstCreation.resolve({
        status: 'ok',
        value: { ...metadata, id: 'first-project', fileName: 'First.pdf', sha256: 'first-hash' },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByText('Second.pdf')).toBeTruthy();

    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Save & close' }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make test change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));

    expect(await screen.findByText('Saved Second.pdf on this device — continue editing anytime.')).toBeTruthy();
    expect(mocks.projectStore.create).toHaveBeenCalledTimes(2);
    expect(mocks.projectStore.saveState).not.toHaveBeenCalled();
  });

  it('autosaves exactly once after the first change and creates nothing if that change is undone', async () => {
    const file = new File(['%PDF-1.7'], 'Autosave.pdf', { type: 'application/pdf' });
    setPendingFile(file);
    render(<App />);
    expect(await screen.findByText('Autosave.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make test change' }));

    await waitFor(() => expect(mocks.projectStore.create).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    expect(mocks.projectStore.create).toHaveBeenCalledTimes(1);

    cleanup();
    vi.clearAllMocks();
    mocks.loadDocument.mockResolvedValue(loadedDocument());
    mocks.sha256Hex.mockResolvedValue('another-hash');
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [] });
    mocks.projectStore.create.mockResolvedValue({ status: 'ok', value: metadata });
    setPendingFile(new File(['%PDF-1.7'], 'Undo.pdf', { type: 'application/pdf' }));
    render(<App />);
    expect(await screen.findByText('Undo.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make test change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo document edit' }));

    await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    expect(mocks.projectStore.create).not.toHaveBeenCalled();
  });

  it('Save & close writes unsaved changes before closing', async () => {
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [metadata] });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue editing' }));
    expect((await screen.findAllByText('Contract.pdf')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Undo document edit' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));

    expect(await screen.findByText(/Saved Contract.pdf on this device/)).toBeTruthy();
    expect(mocks.projectStore.saveState).toHaveBeenCalledTimes(1);
    expect(mocks.projectStore.saveState.mock.calls[0]?.[2]).toMatchObject({ changeCount: 0 });
  });

  it('Save & close finishes an open text box before saving, and waits when it cannot', async () => {
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [metadata] });
    const order: string[] = [];
    mocks.projectStore.saveState.mockImplementation(async () => {
      order.push('save');
      return { status: 'ok', value: metadata };
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue editing' }));
    expect((await screen.findAllByText('Contract.pdf')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Undo document edit' }));

    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const done = document.createElement('button');
    done.setAttribute('data-text-edit-done', '');
    done.disabled = true;
    done.addEventListener('click', () => {
      order.push('done');
      editable.remove();
      done.remove();
    });
    document.body.append(editable, done);

    fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));
    expect(await screen.findByText('Finish or cancel the open text box, then press Save & close again.')).toBeTruthy();
    expect(order).toEqual([]);
    expect(screen.getAllByText('Contract.pdf').length).toBeGreaterThan(0);

    done.disabled = false;
    fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));

    expect(await screen.findByText(/Saved Contract.pdf on this device/)).toBeTruthy();
    expect(order).toEqual(['done', 'save']);
  });

  it('keeps the file open and offers Export when Save & close cannot save', async () => {
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [metadata] });
    mocks.projectStore.saveState.mockResolvedValue({ status: 'full' });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue editing' }));
    expect((await screen.findAllByText('Contract.pdf')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Undo document edit' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain("Couldn't save on this device");
    expect(dialog.textContent).toContain("There isn't enough space on this device to save Contract.pdf.");
    expect(within(dialog).getByRole('button', { name: 'Export PDF' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getAllByText('Contract.pdf').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Save & close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close without saving' }));
    expect(await screen.findByRole('region', { name: 'PDF drop area' })).toBeTruthy();
    expect(screen.queryByText(/Saved Contract.pdf/)).toBeNull();
  });

  it('continues on the saved page with zoom, edits, and working Undo', async () => {
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [metadata] });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Continue editing' }));

    expect((await screen.findAllByText('Contract.pdf')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /currently 150%/ })).toBeTruthy();
    const undo = screen.getByRole('button', { name: 'Undo document edit' }) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Redo document edit' }) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(document.querySelector('main')?.scrollTop).toBe(184);
  });

  it('opens a different dropped PDF without deleting the existing save', async () => {
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [metadata] });
    render(<App />);
    const dropArea = await screen.findByRole('region', { name: 'PDF drop area' });
    const file = new File(['%PDF-1.7'], 'Different.pdf', { type: 'application/pdf' });

    fireEvent.drop(dropArea, { dataTransfer: { files: [file] } });

    expect(await screen.findByText('Different.pdf')).toBeTruthy();
    await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    expect(mocks.projectStore.create).not.toHaveBeenCalled();
    expect(mocks.projectStore.delete).not.toHaveBeenCalled();
  });

  it('checks a tool Open-in-editor handoff and offers saved edits or a fresh project', async () => {
    const file = new File(['%PDF-1.7'], 'tool-output.pdf', { type: 'application/pdf' });
    setPendingFile(file);
    mocks.sha256Hex.mockResolvedValue('same-hash');
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [metadata] });
    render(<App />);

    expect((await screen.findByRole('dialog')).textContent).toContain('You have saved edits for Contract.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Start fresh' }));

    expect(await screen.findByText('tool-output.pdf')).toBeTruthy();
    await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    expect(mocks.projectStore.create).not.toHaveBeenCalled();
    expect(mocks.projectStore.delete).not.toHaveBeenCalled();
  });

  it('shows the saved-files column with the Continue card above the start-screen drop area', async () => {
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [metadata] });
    render(<App />);

    const column = await screen.findByRole('complementary', { name: 'Saved files' });
    const continueButton = await screen.findByRole('button', { name: 'Continue editing' });
    const dropArea = screen.getByRole('button', { name: /Drag & drop your PDF here/ });

    expect(within(column).getByTitle('Contract.pdf')).toBeTruthy();
    expect(Boolean(continueButton.compareDocumentPosition(dropArea) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('opens a saved-file row on its saved page and highlights the current row', async () => {
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [metadata] });
    render(<App />);
    const column = await screen.findByRole('complementary', { name: 'Saved files' });

    fireEvent.click(await within(column).findByTitle('Contract.pdf'));

    await waitFor(() => {
      expect(within(screen.getByRole('banner')).getByText('Contract.pdf')).toBeTruthy();
      expect(within(column).getByTitle('Contract.pdf').getAttribute('aria-current')).toBe('true');
      expect(document.querySelector('main')?.scrollTop).toBe(184);
    });
  });

  it('saves an edited saved file before loading another saved file', async () => {
    const order: string[] = [];
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [otherMetadata, metadata] });
    mocks.projectStore.load.mockImplementation(async (id: string) => {
      order.push(`load:${id}`);
      return { status: 'ok', value: id === otherMetadata.id ? otherStored : stored };
    });
    mocks.projectStore.saveState.mockImplementation(async (id: string) => {
      order.push(`save:${id}`);
      return { status: 'ok', value: metadata };
    });
    render(<App />);
    const column = await screen.findByRole('complementary', { name: 'Saved files' });
    fireEvent.click(await within(column).findByTitle('Contract.pdf'));
    await waitFor(() => expect(within(screen.getByRole('banner')).getByText('Contract.pdf')).toBeTruthy());
    order.length = 0;

    fireEvent.click(screen.getByRole('button', { name: 'Undo document edit' }));
    fireEvent.click(within(column).getByTitle('Other.pdf'));

    await waitFor(() => expect(within(screen.getByRole('banner')).getByText('Other.pdf')).toBeTruthy());
    expect(order).toEqual(['save:saved-project', 'load:other-project']);
  });

  it('creates a changed fresh file before loading a saved file', async () => {
    const order: string[] = [];
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [otherMetadata] });
    mocks.projectStore.create.mockImplementation(async (input: CreateProjectInput) => {
      order.push('create:fresh');
      return {
        status: 'ok',
        value: { ...metadata, id: 'fresh-project', fileName: input.fileName, sha256: input.sha256 },
      };
    });
    mocks.projectStore.load.mockImplementation(async () => {
      order.push('load:other-project');
      return { status: 'ok', value: otherStored };
    });
    setPendingFile(new File(['%PDF-1.7'], 'Fresh.pdf', { type: 'application/pdf' }));
    render(<App />);
    expect(await screen.findByText('Fresh.pdf')).toBeTruthy();
    const column = await screen.findByRole('complementary', { name: 'Saved files' });

    fireEvent.click(screen.getByRole('button', { name: 'Make test change' }));
    fireEvent.click(within(column).getByTitle('Other.pdf'));

    await waitFor(() => expect(within(screen.getByRole('banner')).getByText('Other.pdf')).toBeTruthy());
    expect(order).toEqual(['create:fresh', 'load:other-project']);
  });

  it('offers the target filename after a failed switch save and keeps or discards safely', async () => {
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [otherMetadata, metadata] });
    mocks.projectStore.load.mockImplementation(async (id: string) => ({
      status: 'ok',
      value: id === otherMetadata.id ? otherStored : stored,
    }));
    render(<App />);
    const column = await screen.findByRole('complementary', { name: 'Saved files' });
    fireEvent.click(await within(column).findByTitle('Contract.pdf'));
    await waitFor(() => expect(within(screen.getByRole('banner')).getByText('Contract.pdf')).toBeTruthy());
    mocks.projectStore.saveState.mockResolvedValue({ status: 'full' });
    mocks.projectStore.load.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Undo document edit' }));

    fireEvent.click(within(column).getByTitle('Other.pdf'));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Open Other.pdf without saving' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(within(screen.getByRole('banner')).getByText('Contract.pdf')).toBeTruthy();
    expect(mocks.projectStore.load).not.toHaveBeenCalled();

    fireEvent.click(within(column).getByTitle('Other.pdf'));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open Other.pdf without saving' }));
    await waitFor(() => expect(within(screen.getByRole('banner')).getByText('Other.pdf')).toBeTruthy());
    expect(mocks.projectStore.load).toHaveBeenCalledWith('other-project');
  });

  it('finishes an open text box before saving and switching saved files', async () => {
    const order: string[] = [];
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [otherMetadata, metadata] });
    mocks.projectStore.load.mockImplementation(async (id: string) => {
      order.push(`load:${id}`);
      return { status: 'ok', value: id === otherMetadata.id ? otherStored : stored };
    });
    mocks.projectStore.saveState.mockImplementation(async () => {
      order.push('save');
      return { status: 'ok', value: metadata };
    });
    render(<App />);
    const column = await screen.findByRole('complementary', { name: 'Saved files' });
    fireEvent.click(await within(column).findByTitle('Contract.pdf'));
    await waitFor(() => expect(within(screen.getByRole('banner')).getByText('Contract.pdf')).toBeTruthy());
    order.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Undo document edit' }));

    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const done = document.createElement('button');
    done.setAttribute('data-text-edit-done', '');
    done.addEventListener('click', () => {
      order.push('done');
      editable.remove();
      done.remove();
    });
    document.body.append(editable, done);
    fireEvent.click(within(column).getByTitle('Other.pdf'));

    await waitFor(() => expect(within(screen.getByRole('banner')).getByText('Other.pdf')).toBeTruthy());
    expect(order).toEqual(['done', 'save', 'load:other-project']);
  });

  it('saves before toolbar Open PDF and before dropping a replacement onto an open file', async () => {
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [metadata] });
    render(<App />);
    const column = await screen.findByRole('complementary', { name: 'Saved files' });
    fireEvent.click(await within(column).findByTitle('Contract.pdf'));
    await waitFor(() => expect(within(screen.getByRole('banner')).getByText('Contract.pdf')).toBeTruthy());

    const order: string[] = [];
    mocks.projectStore.saveState.mockImplementation(async () => {
      order.push('save');
      return { status: 'ok', value: metadata };
    });
    mocks.loadDocument.mockImplementation(async () => {
      order.push('open-pdf');
      return loadedDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo document edit' }));
    fireEvent.change(screen.getByLabelText('Open PDF'), {
      target: { files: [new File(['%PDF-1.7'], 'Next.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() => expect(within(screen.getByRole('banner')).getByText('Next.pdf')).toBeTruthy());
    expect(order).toEqual(['save', 'open-pdf']);

    order.length = 0;
    mocks.projectStore.create.mockImplementation(async (input: CreateProjectInput) => {
      order.push('create');
      return {
        status: 'ok',
        value: { ...metadata, id: 'next-project', fileName: input.fileName, sha256: input.sha256 },
      };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make test change' }));
    fireEvent.drop(document.querySelector('main')!, {
      dataTransfer: { files: [new File(['%PDF-1.7'], 'Dropped.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() => expect(within(screen.getByRole('banner')).getByText('Dropped.pdf')).toBeTruthy());
    expect(order).toEqual(['create', 'open-pdf']);
  });

  it('persists the desktop hidden choice and can show the column again', async () => {
    const first = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Hide saved files' }));
    expect(screen.queryByRole('complementary', { name: 'Saved files' })).toBeNull();
    expect(localStorage.getItem('pedf.savedFilesColumn')).toBe('hidden');
    first.unmount();

    render(<App />);
    expect(screen.queryByRole('complementary', { name: 'Saved files' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Saved files' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(await screen.findByRole('complementary', { name: 'Saved files' })).toBeTruthy();
    expect(localStorage.getItem('pedf.savedFilesColumn')).toBe('open');
  });

  it('keeps the saved-files control working when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Hide saved files' }));
    expect(screen.queryByRole('complementary', { name: 'Saved files' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Saved files' }));
    expect(await screen.findByRole('complementary', { name: 'Saved files' })).toBeTruthy();
  });

  it('adds a fresh file to the column after its first saved change without reloading', async () => {
    let projects: ProjectMetadata[] = [];
    mocks.projectStore.list.mockImplementation(async () => ({ status: 'ok', value: projects }));
    mocks.projectStore.create.mockImplementation(async (input: CreateProjectInput) => {
      const created = {
        ...metadata,
        id: 'live-project',
        fileName: input.fileName,
        sha256: input.sha256,
        updatedAt: Date.now(),
      };
      projects = [created];
      notifyProjects();
      return { status: 'ok', value: created };
    });
    setPendingFile(new File(['%PDF-1.7'], 'Live.pdf', { type: 'application/pdf' }));
    render(<App />);
    expect(await screen.findByText('Live.pdf')).toBeTruthy();
    const column = await screen.findByRole('complementary', { name: 'Saved files' });

    fireEvent.click(screen.getByRole('button', { name: 'Make test change' }));

    await waitFor(() => expect(mocks.projectStore.create).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    const row = await within(column).findByTitle('Live.pdf');
    await waitFor(() => expect(row.getAttribute('aria-current')).toBe('true'));
    expect(mocks.loadDocument).toHaveBeenCalledTimes(1);
  });

  it('uses a phone drawer that closes on Escape and after choosing a file', async () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    mocks.projectStore.list.mockResolvedValue({ status: 'ok', value: [otherMetadata] });
    mocks.projectStore.load.mockResolvedValue({ status: 'ok', value: otherStored });
    render(<App />);

    expect(screen.queryByRole('complementary', { name: 'Saved files' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Saved files' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(await screen.findByRole('dialog', { name: 'Saved files drawer' })).toBeTruthy();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Saved files drawer' })).toBeNull());

    fireEvent.click(toggle);
    const drawer = await screen.findByRole('dialog', { name: 'Saved files drawer' });
    fireEvent.click(await within(drawer).findByTitle('Other.pdf'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Saved files drawer' })).toBeNull());
    await waitFor(() => expect(within(screen.getByRole('banner')).getByText('Other.pdf')).toBeTruthy());
  });
});
