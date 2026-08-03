import { useEffect, useRef, useState } from 'react';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { renderPage } from '@/lib/pdf/renderPage';
import { useDocumentStore } from '@/state/documentStore';
import { OverlayLayer } from './OverlayLayer';

interface PageCanvasProps {
  page: PDFPageProxy;
  pageIndex: number;
  zoom: number;
  editMode: boolean;
  peek: boolean;
}

/** One locked PDF.js canvas background for a single page. */
export function PageCanvas({ page, pageIndex, zoom, editMode, peek }: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderInfo, setRenderInfo] = useState<{ viewport: PageViewport; dpr: number } | null>(null);
  const { registerPageCanvas } = useDocumentStore();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { task, viewport, dpr } = renderPage(page, canvas, zoom);
    setRenderInfo({ viewport, dpr });
    registerPageCanvas(pageIndex, { canvas, viewport, dpr });
    task.promise.catch((err: unknown) => {
      // Cancellation during React StrictMode double-invoke / zoom change is expected.
      if (err && (err as { name?: string }).name !== 'RenderingCancelledException') {
        console.error('page render failed', err);
      }
    });

    return () => {
      task.cancel();
      registerPageCanvas(pageIndex, null);
      setRenderInfo(null);
    };
  }, [page, pageIndex, registerPageCanvas, zoom]);

  return (
    <div className="relative bg-white shadow-md">
      <canvas ref={canvasRef} className="block" />
      {renderInfo && (
        <OverlayLayer
          page={page}
          pageIndex={pageIndex}
          viewport={renderInfo.viewport}
          dpr={renderInfo.dpr}
          zoom={zoom}
          editMode={editMode}
          peek={peek}
        />
      )}
    </div>
  );
}
