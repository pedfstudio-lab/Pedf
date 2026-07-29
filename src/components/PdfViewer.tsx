import { useEffect, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { PageCanvas } from './PageCanvas';

interface PdfViewerProps {
  doc: PDFDocumentProxy;
  zoom: number;
}

export function PdfViewer({ doc, zoom }: PdfViewerProps) {
  const [pages, setPages] = useState<PDFPageProxy[]>([]);

  useEffect(() => {
    let cancelled = false;
    setPages([]);
    (async () => {
      const loaded: PDFPageProxy[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        if (cancelled) return;
        loaded.push(page);
      }
      if (!cancelled) setPages(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  return (
    <div className="flex flex-col items-center gap-4 py-4">
      {pages.map((page) => (
        <PageCanvas key={page.pageNumber} page={page} zoom={zoom} />
      ))}
    </div>
  );
}
