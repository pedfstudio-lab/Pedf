import { useCallback, useEffect, useRef, useState } from 'react';
import { Toolbar } from './components/Toolbar';
import { SettingsPanel } from './components/SettingsPanel';
import { PdfChat } from './components/PdfChat';
import { PdfViewer } from './components/PdfViewer';
import { PdfDropZone } from './components/PdfDropZone';
import { loadDocument } from './lib/pdf/loadDocument';
import { pdfToViewport } from './lib/export/coordinates';
import { exportPdf } from './lib/export/exportPdf';
import { sampleDominantColor } from './lib/export/colorSample';
import {
  captureZoomAnchor,
  clampZoom,
  scrollPositionForZoomAnchor,
  type ZoomAnchor,
  ZOOM_STEP,
} from './lib/pdf/zoom';
import type { PdfRect, Rgb } from './lib/export/types';
import { DocumentStoreProvider, useDocumentStore } from './state/documentStore';
import { EditsStoreProvider, useEdits } from './state/editsStore';
import { createPagePlan, planToGeometry } from './state/pagePlan';
import { PrefsStoreProvider } from './state/prefsStore';
import { takePendingFile } from './lib/site/pendingFile';
import { setPendingFiles } from './lib/site/pendingFiles';
import { navigate } from './lib/site/navigate';
import { isPdf } from './lib/site/pdfFile';

function pageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `page-${crypto.randomUUID()}`;
  }
  return `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.matches('input, textarea') || target.isContentEditable);
}

function useEditHistoryShortcuts(): void {
  const { undo, redo, canUndo, canRedo } = useEdits();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.altKey
        || (!event.ctrlKey && !event.metaKey)
        || isEditableTarget(event.target)
      ) return;

      const key = event.key.toLowerCase();
      const shouldUndo = key === 'z' && !event.shiftKey;
      const shouldRedo = (key === 'z' && event.shiftKey) || key === 'y';

      if (shouldUndo && canUndo) {
        event.preventDefault();
        undo();
      } else if (shouldRedo && canRedo) {
        event.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canRedo, canUndo, redo, undo]);
}

function useZoomShortcuts(
  zoomIn: () => void,
  zoomOut: () => void,
  zoomReset: () => void,
): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.altKey
        || (!event.ctrlKey && !event.metaKey)
        || isEditableTarget(event.target)
      ) return;

      const key = event.key.toLowerCase();
      const action = key === '=' || key === '+'
        ? zoomIn
        : key === '-'
          ? zoomOut
          : key === '0'
            ? zoomReset
            : null;
      if (!action) return;

      event.preventDefault();
      action();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomIn, zoomOut, zoomReset]);
}

function EditorApp() {
  const { document, setDocument, getPageCanvas } = useDocumentStore();
  const { edits, pagePlan, resetDocument } = useEdits();
  useEditHistoryShortcuts();
  const [error, setError] = useState<string | null>(null);
  const [repairFile, setRepairFile] = useState<File | null>(null);
  const [draggingOverEmpty, setDraggingOverEmpty] = useState(false);
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLElement>(null);
  const pendingAnchor = useRef<ZoomAnchor | null>(null);
  const captureAnchor = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    pendingAnchor.current = captureZoomAnchor(scroll);
  }, []);
  const zoomIn = useCallback(() => {
    const next = clampZoom(zoom + ZOOM_STEP);
    if (next === zoom) return;
    captureAnchor();
    setZoom(next);
  }, [captureAnchor, zoom]);
  const zoomOut = useCallback(() => {
    const next = clampZoom(zoom - ZOOM_STEP);
    if (next === zoom) return;
    captureAnchor();
    setZoom(next);
  }, [captureAnchor, zoom]);
  const zoomReset = useCallback(() => {
    if (zoom === 1) return;
    captureAnchor();
    setZoom(1);
  }, [captureAnchor, zoom]);
  useZoomShortcuts(zoomIn, zoomOut, zoomReset);
  const [editMode, setEditMode] = useState(false);
  const [textAddMode, setTextAddMode] = useState(false);
  const [imageMode, setImageMode] = useState(false);
  const [peek, setPeek] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [downloadReady, setDownloadReady] = useState<{ url: string; name: string } | null>(null);
  const pendingFileChecked = useRef(false);

  useEffect(() => {
    const scroll = scrollRef.current;
    const content = scroll?.firstElementChild;
    if (!scroll || !content || typeof ResizeObserver === 'undefined') return;

    let settle: number | undefined;
    const observer = new ResizeObserver(() => {
      const anchor = pendingAnchor.current;
      if (!anchor) return;

      const position = scrollPositionForZoomAnchor(anchor, scroll);
      scroll.scrollTop = position.top;
      scroll.scrollLeft = position.left;
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        pendingAnchor.current = null;
      }, 200);
    });
    observer.observe(content);

    return () => {
      observer.disconnect();
      window.clearTimeout(settle);
      pendingAnchor.current = null;
    };
  }, [document]);

  const open = useCallback(async (source: File | ArrayBuffer, name: string) => {
    setError(null);
    setRepairFile(null);
    try {
      const loaded = await loadDocument(source);
      setDocument({ loaded, fileName: name });
      resetDocument(createPagePlan(loaded.pages.length, pageId));
      setEditMode(false);
      setTextAddMode(false);
      setImageMode(false);
      setChatOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (source instanceof File) setRepairFile(source);
    }
  }, [resetDocument, setDocument]);

  useEffect(() => {
    if (pendingFileChecked.current) return;
    pendingFileChecked.current = true;
    const pending = takePendingFile();
    if (!pending) return;
    void open(pending, pending.name);
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
      const pages = planToGeometry(pagePlan, document.loaded.pages);
      const result = await exportPdf({
        originalBytes: document.loaded.originalBytes,
        edits: [...edits],
        pages,
        plan: pagePlan,
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
  }, [document, edits, exporting, pagePlan, sampleBackground]);

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
        zoom={zoom}
        zoomIn={zoomIn}
        zoomOut={zoomOut}
        zoomReset={zoomReset}
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
      <main ref={scrollRef} className="flex-1 overflow-auto">
        {error && (
          <div className="m-4 flex flex-wrap items-center gap-3 rounded bg-red-100 p-3 text-sm text-red-800">
            <span>{error}</span>
            {repairFile && <button type="button" className="rounded border border-red-300 bg-white px-3 py-2 font-semibold text-red-800"
              onClick={() => {
                setPendingFiles([repairFile]);
                navigate('/tools/repair');
              }}>Try Repair PDF</button>}
          </div>
        )}
        {document ? (
          <PdfViewer
            doc={document.loaded.doc}
            originalPages={document.loaded.pages}
            zoom={zoom}
            editMode={editMode}
            textAddMode={textAddMode}
            imageMode={imageMode}
            peek={peek}
          />
        ) : (
          <div
            role="region"
            aria-label="PDF drop area"
            className={`flex h-full flex-col items-center justify-center gap-5 px-6 text-center text-neutral-500 ${draggingOverEmpty ? 'bg-blue-50 outline-2 -outline-offset-4 outline-blue-400' : ''}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDraggingOverEmpty(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
              setDraggingOverEmpty(false);
            }}
            onDrop={(event) => {
              setDraggingOverEmpty(false);
              // The shared box handles its own drops; bubbling must not open twice.
              if (event.defaultPrevented) return;
              event.preventDefault();
              const file = event.dataTransfer.files[0];
              if (!file) return;
              if (!isPdf(file)) {
                setError('Choose a PDF file.');
                return;
              }
              void open(file, file.name);
            }}
          >
            <p>Open a PDF to begin.</p>
            <PdfDropZone onFile={(file) => void open(file, file.name)} onError={setError} />
          </div>
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
