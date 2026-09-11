// @vitest-environment jsdom
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { takePendingFile } from './lib/site/pendingFile';
import { Root } from './routes';

const { loadDocument } = vi.hoisted(() => ({ loadDocument: vi.fn() }));

// Exercise the real landing, router, App handoff and toolbar. PDF rendering and
// speech need browser APIs; their internals are covered by their own suites.
vi.mock('./lib/pdf/loadDocument', () => ({ loadDocument }));
vi.mock('./lib/export/exportPdf', () => ({ exportPdf: vi.fn() }));
vi.mock('./components/PdfViewer', () => ({ PdfViewer: () => null }));
vi.mock('./components/PdfChat', () => ({ PdfChat: () => null }));
vi.mock('./components/SettingsPanel', () => ({ SettingsPanel: () => null }));

describe('landing PDF handoff to the editor', () => {
  const fetchSample = vi.fn();

  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    takePendingFile();
    vi.resetAllMocks();
    vi.stubGlobal('fetch', fetchSample);
    loadDocument.mockResolvedValue({
      doc: { destroy: vi.fn() },
      originalBytes: new Uint8Array(),
      pages: [{
        pageIndex: 0,
        widthPt: 612,
        heightPt: 792,
        rotation: 0,
        boxOffset: { x: 0, y: 0 },
      }],
    });
  });

  afterEach(() => {
    cleanup();
    takePendingFile();
    vi.unstubAllGlobals();
  });

  it('opens an empty editor without fetching anything when no file is pending', async () => {
    window.history.replaceState({}, '', '/app');
    render(<StrictMode><Root /></StrictMode>);

    // The first lazy editor import also compiles during this integration test.
    expect(await screen.findByText('Open a PDF to begin.', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: /drag & drop your PDF here/i })).toBeTruthy();
    expect(screen.getByText('or click to upload')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Load sample' })).toBeNull();
    expect(fetchSample).not.toHaveBeenCalled();
    expect(loadDocument).not.toHaveBeenCalled();
  });

  it('opens a PDF dropped directly on the empty editor', async () => {
    window.history.replaceState({}, '', '/app');
    render(<StrictMode><Root /></StrictMode>);
    const dropArea = await screen.findByRole('region', { name: 'PDF drop area' });
    const file = new File(['%PDF-1.7'], 'editor-drop.pdf', { type: 'application/pdf' });

    fireEvent.drop(dropArea, { dataTransfer: { files: [file] } });

    expect(await screen.findByText(file.name)).toBeTruthy();
    expect(loadDocument).toHaveBeenCalledTimes(1);
    expect(loadDocument).toHaveBeenCalledWith(file);
    expect(fetchSample).not.toHaveBeenCalled();
  });

  it('rejects a non-PDF drop and keeps the empty drop area available', async () => {
    window.history.replaceState({}, '', '/app');
    render(<StrictMode><Root /></StrictMode>);
    const dropArea = await screen.findByRole('region', { name: 'PDF drop area' });

    fireEvent.drop(dropArea, {
      dataTransfer: { files: [new File(['image'], 'photo.png', { type: 'image/png' })] },
    });

    expect(await screen.findByText('Choose a PDF file.')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'PDF drop area' })).toBeTruthy();
    expect(loadDocument).not.toHaveBeenCalled();
    expect(fetchSample).not.toHaveBeenCalled();
  });

  it('offers a failed editor file directly to Repair PDF', async () => {
    window.history.replaceState({}, '', '/app');
    loadDocument.mockRejectedValueOnce(new Error('Failed to load PDF document.'));
    render(<StrictMode><Root /></StrictMode>);
    const input = await screen.findByLabelText('Drag & drop your PDF here');
    const broken = new File(['%PDF-1.7 broken'], 'broken.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [broken] } });
    expect(await screen.findByText('Failed to load PDF document.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try Repair PDF' }));

    expect(window.location.pathname).toBe('/tools/repair');
    expect(await screen.findByRole('heading', { level: 1, name: 'Repair PDF' }, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('broken.pdf')).toBeTruthy();
  });

  it('opens the exact PDF chosen in the empty editor upload box without fetching a sample', async () => {
    window.history.replaceState({}, '', '/app');
    render(<StrictMode><Root /></StrictMode>);
    const input = await screen.findByLabelText('Drag & drop your PDF here');
    const file = new File(['%PDF-1.7'], 'editor-pick.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(file.name)).toBeTruthy();
    expect(loadDocument).toHaveBeenCalledTimes(1);
    expect(loadDocument).toHaveBeenCalledWith(file);
    expect(fetchSample).not.toHaveBeenCalled();
  });

  it('opens a PDF dropped on the editor box only once when the drop bubbles to the outer area', async () => {
    window.history.replaceState({}, '', '/app');
    render(<StrictMode><Root /></StrictMode>);
    const box = await screen.findByRole('button', { name: /drag & drop your PDF here/i });
    const file = new File(['%PDF-1.7'], 'box-drop.pdf', { type: 'application/pdf' });

    fireEvent.dragEnter(box);
    fireEvent.drop(box, { dataTransfer: { files: [file] } });

    expect(await screen.findByText(file.name)).toBeTruthy();
    expect(loadDocument).toHaveBeenCalledTimes(1);
    expect(loadDocument).toHaveBeenCalledWith(file);
    expect(fetchSample).not.toHaveBeenCalled();
  });

  it.each(['pick', 'drop'] as const)('opens the exact PDF from %s, not the bundled sample', async (method) => {
    const originalDocument = window.document;
    const file = new File(['%PDF-1.7'], `${method}-test.pdf`, { type: 'application/pdf' });
    const { container } = render(<StrictMode><Root /></StrictMode>);

    if (method === 'pick') {
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      fireEvent.change(input, { target: { files: [file] } });
    } else {
      fireEvent.drop(screen.getByRole('button', { name: /drag & drop your PDF here/i }), {
        dataTransfer: { files: [file] },
      });
    }

    expect(await screen.findByText(file.name)).toBeTruthy();
    expect(window.location.pathname).toBe('/app');
    expect(window.document).toBe(originalDocument);
    expect(loadDocument).toHaveBeenCalledTimes(1);
    expect(loadDocument).toHaveBeenCalledWith(file);
    expect(fetchSample).not.toHaveBeenCalled();
    expect(takePendingFile()).toBeUndefined();
  });
});
