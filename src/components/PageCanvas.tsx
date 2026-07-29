import { useEffect, useRef } from 'react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { renderPage } from '@/lib/pdf/renderPage';

interface PageCanvasProps {
  page: PDFPageProxy;
  zoom: number;
}

/** One locked PDF.js canvas background for a single page. */
export function PageCanvas({ page, zoom }: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { task } = renderPage(page, canvas, zoom);
    task.promise.catch((err: unknown) => {
      // Cancellation during React StrictMode double-invoke / zoom change is expected.
      if (err && (err as { name?: string }).name !== 'RenderingCancelledException') {
        console.error('page render failed', err);
      }
    });

    return () => {
      task.cancel();
    };
  }, [page, zoom]);

  return (
    <div className="relative bg-white shadow-md">
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
