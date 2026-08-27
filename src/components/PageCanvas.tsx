import { useEffect, useRef, useState } from 'react';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { createBlankViewport } from '@/lib/pdf/blankViewport';
import { renderPage } from '@/lib/pdf/renderPage';
import { useDocumentStore } from '@/state/documentStore';
import { OverlayLayer } from './OverlayLayer';

interface PageCanvasProps {
  source:
    | { readonly kind: 'pdf'; readonly page: PDFPageProxy }
    | { readonly kind: 'blank'; readonly widthPt: number; readonly heightPt: number };
  pageIndex: number;
  zoom: number;
  editMode: boolean;
  textAddMode: boolean;
  imageMode: boolean;
  peek: boolean;
}

/** One locked PDF.js canvas background for a single page. */
export function PageCanvas({ source, pageIndex, zoom, editMode, textAddMode, imageMode, peek }: PageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderInfo, setRenderInfo] = useState<{ viewport: PageViewport; dpr: number } | null>(null);
  const { registerPageCanvas } = useDocumentStore();
  const page = source.kind === 'pdf' ? source.page : undefined;
  const blankWidth = source.kind === 'blank' ? source.widthPt : undefined;
  const blankHeight = source.kind === 'blank' ? source.heightPt : undefined;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    setRenderInfo(null);
    registerPageCanvas(pageIndex, null);
    if (!page && blankWidth && blankHeight) {
      const dpr = window.devicePixelRatio || 1;
      const viewport = createBlankViewport(blankWidth, blankHeight, zoom * dpr);
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('2D canvas context unavailable');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      registerPageCanvas(pageIndex, { canvas, viewport, dpr });
      setRenderInfo({ viewport, dpr });
      return () => {
        registerPageCanvas(pageIndex, null);
        setRenderInfo(null);
      };
    }
    if (!page) return;
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
  }, [blankHeight, blankWidth, page, pageIndex, registerPageCanvas, zoom]);

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
