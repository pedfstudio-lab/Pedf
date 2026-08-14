import { useCallback, useEffect, useState } from 'react';
import { Toolbar } from './components/Toolbar';
import { SettingsPanel } from './components/SettingsPanel';
import { PdfChat } from './components/PdfChat';
import { PdfViewer } from './components/PdfViewer';
import { loadDocument } from './lib/pdf/loadDocument';
import { pdfToViewport } from './lib/export/coordinates';
import { exportPdf } from './lib/export/exportPdf';
import { sampleDominantColor } from './lib/export/colorSample';
import type { PdfRect, Rgb } from './lib/export/types';
import { DocumentStoreProvider, useDocumentStore } from './state/documentStore';
import { EditsStoreProvider, useEdits } from './state/editsStore';
import { PrefsStoreProvider } from './state/prefsStore';

// Optional dev convenience: auto-load a sample dropped at public/samples/.
const DEFAULT_SAMPLE = `${import.meta.env.BASE_URL}samples/GOA%202026.pdf`;

function EditorApp() {
  const { document, setDocument, getPageCanvas } = useDocumentStore();
  const { edits, resetEdits } = useEdits();
  const [error, setError] = useState<string | null>(null);
  const [zoom] = useState(1.5);
  const [editMode, setEditMode] = useState(false);
  const [textAddMode, setTextAddMode] = useState(false);
  const [imageMode, setImageMode] = useState(false);
  const [peek, setPeek] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [downloadReady, setDownloadReady] = useState<{ url: string; name: string } | null>(null);

  const open = useCallback(async (source: File | ArrayBuffer, name: string) => {
    setError(null);
    try {
      const loaded = await loadDocument(source);
      setDocument({ loaded, fileName: name });
      resetEdits();
      setEditMode(false);
      setTextAddMode(false);
      setImageMode(false);
      setChatOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [resetEdits, setDocument]);

  // Try the bundled sample on first load. Silently ignore if it isn't present
  // (Vite's dev server answers unknown paths with index.html, so verify %PDF-).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(DEFAULT_SAMPLE);
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        const head = new Uint8Array(buf.slice(0, 5));
        if (String.fromCharCode(...head) !== '%PDF-') return;
        if (!cancelled) await open(buf, 'GOA 2026.pdf');
      } catch {
        /* no sample present — that's fine */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    const loaded = document?.loaded;
    return () => {
      if (loaded) void loaded.doc.destroy();
    };
  }, [document]);

  useEffect(() => {
    return () => {
      if (downloadReady) URL.revokeObjectURL(downloadReady.url);
    };
  }, [downloadReady]);

  const sampleBackground = useCallback(
    (pageIndex: number, rect: PdfRect): Rgb => {
      const registration = getPageCanvas(pageIndex);
      if (!registration) return { r: 1, g: 1, b: 1 };

      const { canvas, viewport } = registration;
      const first = pdfToViewport(viewport, { x: rect.x, y: rect.y });
      const second = pdfToViewport(viewport, { x: rect.x + rect.w, y: rect.y + rect.h });
      const left = Math.max(0, Math.floor(Math.min(first.x, second.x)));
      const top = Math.max(0, Math.floor(Math.min(first.y, second.y)));
      const right = Math.min(canvas.width, Math.ceil(Math.max(first.x, second.x)));
      const bottom = Math.min(canvas.height, Math.ceil(Math.max(first.y, second.y)));
      const width = Math.max(1, right - left);
      const height = Math.max(1, bottom - top);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return { r: 1, g: 1, b: 1 };

      return sampleDominantColor(context.getImageData(left, top, width, height).data);
    },
    [getPageCanvas],
  );

  const handleExport = useCallback(async () => {
    if (!document || exporting) return;
    setError(null);
    setWarnings([]);
    setDownloadReady(null);
    setExporting(true);
    try {
      const result = await exportPdf({
        originalBytes: document.loaded.originalBytes,
        edits: [...edits],
        pages: document.loaded.pages,
        sampleBackground,
      });
      const blob = new Blob([result.bytes.slice().buffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      const baseName = document.fileName.replace(/\.pdf$/i, '');
      anchor.href = url;
      const downloadName = `${baseName}-edited.pdf`;
      anchor.download = downloadName;
      anchor.hidden = true;
      window.document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setDownloadReady({ url, name: downloadName });
      setWarnings(result.warnings);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExporting(false);
    }
  }, [document, edits, exporting, sampleBackground]);

  return (
    <div className="flex h-full flex-col bg-neutral-100">
      <Toolbar
        onOpen={(file) => open(file, file.name)}
        fileName={document?.fileName ?? null}
        editMode={editMode}
        textAddMode={textAddMode}
        imageMode={imageMode}
        hasEdits={edits.length > 0}
        exporting={exporting}
        onEditModeChange={(enabled) => {
          setEditMode(enabled);
          if (enabled) {
            setTextAddMode(false);
            setImageMode(false);
          }
        }}
        onTextAddModeChange={(enabled) => {
          setTextAddMode(enabled);
          if (enabled) {
            setEditMode(false);
            setImageMode(false);
          }
        }}
        onImageModeChange={(enabled) => {
          setImageMode(enabled);
          if (enabled) {
            setEditMode(false);
            setTextAddMode(false);
          }
        }}
        onOpenChat={() => {
          setSettingsOpen(false);
          setChatOpen(true);
        }}
        onOpenSettings={() => {
          setChatOpen(false);
          setSettingsOpen(true);
        }}
        onPeekChange={setPeek}
        onExport={() => void handleExport()}
      />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <PdfChat
        open={chatOpen}
        doc={document?.loaded.doc ?? null}
        onClose={() => setChatOpen(false)}
        onOpenSettings={() => {
          setChatOpen(false);
          setSettingsOpen(true);
        }}
      />
      <main className="flex-1 overflow-auto">
        {error && (
          <div className="m-4 rounded bg-red-100 p-3 text-sm text-red-800">{error}</div>
        )}
        {document ? (
          <PdfViewer
            doc={document.loaded.doc}
            zoom={zoom}
            editMode={editMode}
            textAddMode={textAddMode}
            imageMode={imageMode}
            peek={peek}
          />
        ) : (
          !error && (
            <div className="flex h-full items-center justify-center px-6 text-center text-neutral-500">
              Open a PDF to begin — or drop one at{' '}
              <code className="mx-1 rounded bg-neutral-200 px-1 py-0.5 text-neutral-700">
                public/samples/GOA 2026.pdf
              </code>
            </div>
          )
        )}
      </main>
      {warnings.length > 0 && (
        <aside className="fixed bottom-4 right-4 z-[100] max-w-md rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 shadow-xl" role="status">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-semibold">Exported with font substitutions</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            </div>
            <button type="button" onClick={() => setWarnings([])} className="rounded px-1 text-lg leading-none hover:bg-amber-100" aria-label="Dismiss export warnings">×</button>
          </div>
        </aside>
      )}
      {downloadReady && (
        <aside className="fixed bottom-4 left-4 z-[100] flex items-center gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950 shadow-xl" role="status">
          <span>Export ready</span>
          <a href={downloadReady.url} download={downloadReady.name} className="rounded bg-emerald-700 px-3 py-1.5 font-semibold text-white hover:bg-emerald-600">
            Download edited PDF
          </a>
          <button type="button" onClick={() => setDownloadReady(null)} className="rounded px-1 text-lg leading-none hover:bg-emerald-100" aria-label="Dismiss download">×</button>
        </aside>
      )}
    </div>
  );
}

export default function App() {
  return (
    <PrefsStoreProvider>
      <DocumentStoreProvider>
        <EditsStoreProvider>
          <EditorApp />
        </EditsStoreProvider>
      </DocumentStoreProvider>
    </PrefsStoreProvider>
  );
}
