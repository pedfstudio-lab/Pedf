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
  textAddMode: boolean;
  imageMode: boolean;
  peek: boolean;
}

/** One locked PDF.js canvas background for a single page. */
export function PageCanvas({ page, pageIndex, zoom, editMode, textAddMode, imageMode, peek }: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderInfo, setRenderInfo] = useState<{ viewport: PageViewport; dpr: number } | null>(null);
  const { registerPageCanvas } = useDocumentStore();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    setRenderInfo(null);
    registerPageCanvas(pageIndex, null);
    const { task, viewport, dpr } = renderPage(page, canvas, zoom);
    void task.promise
      .then(() => {
        if (cancelled) return;
        registerPageCanvas(pageIndex, { canvas, viewport, dpr });
        setRenderInfo({ viewport, dpr });
      })
      .catch((err: unknown) => {
        // Cancellation during React StrictMode double-invoke / zoom change is expected.
        if (err && (err as { name?: string }).name !== 'RenderingCancelledException') {
          console.error('page render failed', err);
        }
      });

    return () => {
      cancelled = true;
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
          textAddMode={textAddMode}
          imageMode={imageMode}
          peek={peek}
        />
      )}
    </div>
  );
}
