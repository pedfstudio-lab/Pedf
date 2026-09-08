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
    vi.clearAllMocks();
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
