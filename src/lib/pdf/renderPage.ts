import type { PDFPageProxy, PageViewport, RenderTask } from 'pdfjs-dist';

export interface PageRender {
  /** The in-flight render task — await `task.promise`, cancel on cleanup. */
  task: RenderTask;
  /** The viewport used (rotation baked in) — source of truth for coordinate math. */
  viewport: PageViewport;
  dpr: number;
  zoom: number;
  renderScale: number;
}

/**
 * Sizes the canvas and starts rendering `page` as a locked background.
 *
 * Backing store = viewport pixels (zoom * dpr); CSS box = viewport / dpr, so it
 * displays at `zoom`. This is the SINGLE owner of canvas sizing — overlays must
 * derive their geometry only through the coordinate transforms, never by
 * re-measuring the canvas.
 */
export function renderPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  zoom: number,
): PageRender {
  const dpr = window.devicePixelRatio || 1;
  const renderScale = zoom * dpr;
  const viewport = page.getViewport({ scale: renderScale });

  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${viewport.width / dpr}px`;
  canvas.style.height = `${viewport.height / dpr}px`;

  // willReadFrequently: the export path samples this raster for cover-patch colors.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');

  const task = page.render({ canvasContext: ctx, viewport });
  return { task, viewport, dpr, zoom, renderScale };
}
