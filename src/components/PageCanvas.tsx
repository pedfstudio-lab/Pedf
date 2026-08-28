import { useEffect, useRef, useState } from 'react';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { createBlankViewport } from '@/lib/pdf/blankViewport';
import {
  samePageRenderIdentity,
  shouldRasterizeInitially,
} from '@/lib/pdf/pageRenderState';
import type { PageRenderIdentity } from '@/lib/pdf/pageRenderState';
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

interface RenderInfo {
  readonly identity: PageRenderIdentity;
  readonly viewport: PageViewport;
  readonly dpr: number;
  readonly zoom: number;
}

/** One locked PDF.js canvas background for a single page. */
export function PageCanvas({ source, pageIndex, zoom, editMode, textAddMode, imageMode, peek }: PageCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderInfo, setRenderInfo] = useState<RenderInfo | null>(null);
  const { registerPageCanvas } = useDocumentStore();
  const page = source.kind === 'pdf' ? source.page : undefined;
  const blankWidth = source.kind === 'blank' ? source.widthPt : undefined;
  const blankHeight = source.kind === 'blank' ? source.heightPt : undefined;
  const [shouldRasterize, setShouldRasterize] = useState(() => shouldRasterizeInitially(
    pageIndex,
    typeof IntersectionObserver !== 'undefined',
  ));
  const identity: PageRenderIdentity = { page, pageIndex, blankWidth, blankHeight };
  const activeRenderInfo = renderInfo && samePageRenderIdentity(renderInfo.identity, identity)
    ? renderInfo
    : null;
  const cssViewport = page?.getViewport({ scale: zoom });
  const cssWidth = cssViewport?.width ?? (blankWidth ?? 0) * zoom;
  const cssHeight = cssViewport?.height ?? (blankHeight ?? 0) * zoom;

  useEffect(() => {
    const container = containerRef.current;
    if (shouldRasterize || !container || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setShouldRasterize(true);
      observer.disconnect();
    }, {
      root: container.closest('main'),
      rootMargin: '1200px 0px',
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [shouldRasterize]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Blank pages are cheap to paint; PDF pages wait until they approach the viewport.
    if (page && !shouldRasterize) return;

    let cancelled = false;
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
      setRenderInfo({
        identity: { page, pageIndex, blankWidth, blankHeight },
        viewport,
        dpr,
        zoom,
      });
      return () => {
        registerPageCanvas(pageIndex, null);
      };
    }
    if (!page) return;
    const { task, viewport, dpr } = renderPage(page, canvas, zoom);
    setRenderInfo({
      identity: { page, pageIndex, blankWidth, blankHeight },
      viewport,
      dpr,
      zoom,
    });
    void task.promise
      .then(() => {
        if (cancelled) return;
        registerPageCanvas(pageIndex, { canvas, viewport, dpr });
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
    };
  }, [blankHeight, blankWidth, page, pageIndex, registerPageCanvas, shouldRasterize, zoom]);

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden bg-white shadow-md"
      style={{ width: cssWidth, height: cssHeight }}
    >
      <canvas ref={canvasRef} className="block" style={{ width: cssWidth, height: cssHeight }} />
      {activeRenderInfo && (
        <OverlayLayer
          page={page}
          pageIndex={pageIndex}
          viewport={activeRenderInfo.viewport}
          dpr={activeRenderInfo.dpr}
          zoom={activeRenderInfo.zoom}
          editMode={editMode}
          textAddMode={textAddMode}
          imageMode={imageMode}
          peek={peek}
        />
      )}
    </div>
  );
}
