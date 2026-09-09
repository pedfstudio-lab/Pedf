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
