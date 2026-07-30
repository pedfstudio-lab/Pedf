import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Toolbar } from './components/Toolbar';
import { PdfViewer } from './components/PdfViewer';
import { loadDocument } from './lib/pdf/loadDocument';

// Optional dev convenience: auto-load a sample dropped at public/samples/.
const DEFAULT_SAMPLE = `${import.meta.env.BASE_URL}samples/sample-basic.pdf`;

export default function App() {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom] = useState(1.5);

  async function open(source: File | ArrayBuffer, name: string) {
    setError(null);
    try {
      const loaded = await loadDocument(source);
      setDoc(loaded.doc);
      setFileName(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

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
        if (!cancelled) await open(buf, 'sample-basic.pdf');
      } catch {
        /* no sample present — that's fine */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-neutral-100">
      <Toolbar onOpen={(f) => open(f, f.name)} fileName={fileName} />
      <main className="flex-1 overflow-auto">
        {error && (
          <div className="m-4 rounded bg-red-100 p-3 text-sm text-red-800">{error}</div>
        )}
        {doc ? (
          <PdfViewer doc={doc} zoom={zoom} />
        ) : (
          !error && (
            <div className="flex h-full items-center justify-center px-6 text-center text-neutral-500">
              Open a PDF to begin — or drop one at{' '}
              <code className="mx-1 rounded bg-neutral-200 px-1 py-0.5 text-neutral-700">
                public/samples/sample-basic.pdf
              </code>
            </div>
          )
        )}
      </main>
    </div>
  );
}
