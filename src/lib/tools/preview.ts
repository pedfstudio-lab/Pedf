import { loadPdfJs } from './pdfIo';
import { renderPage } from '@/lib/pdf/renderPage';

export async function previewPdf(file: File, signal: AbortSignal): Promise<{ pages: number; thumbnail: string }> {
  const loaded = await loadPdfJs(file);
  try {
    signal.throwIfAborted();
    const page = await loaded.doc.getPage(1);
    signal.throwIfAborted();
    const canvas = document.createElement('canvas');
    const scale = 100 / page.getViewport({ scale: 1 }).width;
    const { task } = renderPage(page, canvas, scale);
    const cancel = () => task.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await task.promise;
      signal.throwIfAborted();
      return { pages: loaded.doc.numPages, thumbnail: canvas.toDataURL('image/png') };
    } finally {
      signal.removeEventListener('abort', cancel);
      canvas.width = canvas.height = 0;
    }
  } finally {
    await loaded.doc.destroy();
  }
}

export interface PreviewPageSize { w: number; h: number }

export async function previewPdfPages(
  file: File,
  signal: AbortSignal,
  onPage: (pageIndex: number, thumbnail: string, sizePt: PreviewPageSize) => void,
  longSidePx = 140,
  /** Called once, before any thumbnail, so callers can lay out every page immediately. */
  onCount?: (pageCount: number) => void,
): Promise<void> {
  const loaded = await loadPdfJs(file);
  try {
    signal.throwIfAborted();
    onCount?.(loaded.doc.numPages);
    for (let pageIndex = 0; pageIndex < loaded.doc.numPages; pageIndex++) {
      signal.throwIfAborted();
      const page = await loaded.doc.getPage(pageIndex + 1);
      const canvas = document.createElement('canvas');
      let task: ReturnType<typeof page.render> | undefined;
      const cancel = () => task?.cancel();
      try {
        const natural = page.getViewport({ scale: 1 });
        const scale = longSidePx / Math.max(natural.width, natural.height);
        const viewport = page.getViewport({ scale });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is unavailable.');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        task = page.render({ canvasContext: context, viewport, intent: 'print' });
        signal.addEventListener('abort', cancel, { once: true });
        await task.promise;
        signal.throwIfAborted();
        onPage(pageIndex, canvas.toDataURL('image/png'), { w: natural.width, h: natural.height });
      } finally {
        signal.removeEventListener('abort', cancel);
        page.cleanup();
        canvas.width = canvas.height = 0;
      }
      if (pageIndex < loaded.doc.numPages - 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  } finally {
    await loaded.doc.destroy();
  }
}
