import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { PdfToJpgOptions } from '@/components/tools/PdfToJpgOptions';
import { ToolError } from './errors';
import { loadPdfJs, outputName } from './pdfIo';
import {
  DEFAULT_PDF_TO_JPG_OPTIONS,
  dpiForQuality,
  parsePdfToJpgOptions,
  selectedPageIndices,
} from './pdfToJpgOptions';
import type { ToolContext, ToolDefinition, ToolOptions, ToolOutput } from './types';

export const SINGLE_PDF_ERROR = 'Choose one PDF file to convert.';
export const IMAGE_ENCODE_ERROR = 'A page image could not be prepared.';
export const IMAGE_RENDER_ERROR = 'A PDF page could not be rendered.';
export const DEVICE_MEMORY_WARNING = "Some pages were rendered smaller than requested to fit your device's memory.";
export const BIG_JOB_WARNING = 'This is a big job — it may take a while and use a lot of memory. Consider Normal quality or a page range.';
export const MAX_CANVAS_PIXELS = 16_000_000;

export interface RenderedPageImage {
  bytes: Uint8Array;
  width: number;
  height: number;
  scaledDown: boolean;
}

export function isBigJob(pageCount: number, dpi: number): boolean {
  return pageCount > 100 && dpi === 300;
}

function boundedViewport(page: PDFPageProxy, dpi: number): { viewport: PageViewport; scaledDown: boolean } {
  const requestedScale = dpi / 72;
  let viewport = page.getViewport({ scale: requestedScale });
  let width = Math.ceil(viewport.width);
  let height = Math.ceil(viewport.height);
  if (width * height <= MAX_CANVAS_PIXELS) return { viewport, scaledDown: false };
  let scale = requestedScale * Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
  viewport = page.getViewport({ scale });
  width = Math.ceil(viewport.width);
  height = Math.ceil(viewport.height);
  // Ceil rounding can leave the first estimate a handful of pixels over the cap.
  while (width * height > MAX_CANVAS_PIXELS) {
    scale *= Math.sqrt(MAX_CANVAS_PIXELS / (width * height)) * 0.999999;
    viewport = page.getViewport({ scale });
    width = Math.ceil(viewport.width);
    height = Math.ceil(viewport.height);
  }
  return { viewport, scaledDown: true };
}

async function encodeCanvas(canvas: HTMLCanvasElement, format: 'jpg' | 'png'): Promise<Uint8Array> {
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (result) => result ? resolve(result) : reject(new ToolError(IMAGE_ENCODE_ERROR)),
    mime,
    format === 'jpg' ? 0.9 : undefined,
  ));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function renderPageImage(
  page: PDFPageProxy,
  dpi: number,
  format: 'jpg' | 'png',
  signal: AbortSignal,
): Promise<RenderedPageImage> {
  signal.throwIfAborted();
  const { viewport, scaledDown } = boundedViewport(page, dpi);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new ToolError(IMAGE_RENDER_ERROR);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    // 'print' intent renders without waiting for animation frames, so a conversion keeps
    // going while the tab is in the background (display intent pauses in hidden tabs).
    const task = page.render({ canvasContext: context, viewport, intent: 'print' });
    const cancel = () => task.cancel();
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await task.promise;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ToolError) throw error;
      throw new ToolError(IMAGE_RENDER_ERROR);
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    signal.throwIfAborted();
    const bytes = await encodeCanvas(canvas, format);
    signal.throwIfAborted();
    return { bytes, width: canvas.width, height: canvas.height, scaledDown };
  } finally {
    canvas.width = canvas.height = 0;
    page.cleanup();
  }
}

/** A timer, not an animation frame: frames stop in hidden tabs, timers keep running. */
async function yieldToUi(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function pageOutputName(file: File, pageNumber: number, pageCount: number, format: 'jpg' | 'png'): string {
  const padded = String(pageNumber).padStart(String(pageCount).length, '0');
  return outputName(file, `page-${padded}`, format);
}

export async function run(inputs: File[], options: ToolOptions, ctx: ToolContext): Promise<ToolOutput[]> {
  const { signal, onProgress, onWarning } = ctx;
  signal.throwIfAborted();
  if (inputs.length !== 1) throw new ToolError(SINGLE_PDF_ERROR);
  const file = inputs[0]!;
  const loaded = await loadPdfJs(file);
  try {
    signal.throwIfAborted();
    const value = parsePdfToJpgOptions(options);
    const dpi = dpiForQuality(value.quality);
    const pages = selectedPageIndices(value, loaded.doc.numPages);
    if (isBigJob(pages.length, dpi)) onWarning?.(BIG_JOB_WARNING);
    const outputs: ToolOutput[] = [];
    let warnedForMemory = false;
    for (const [index, pageIndex] of pages.entries()) {
      signal.throwIfAborted();
      const pageNumber = pageIndex + 1;
      onProgress(index, pages.length, `Rendering page ${pageNumber} of ${loaded.doc.numPages}`);
      const page = await loaded.doc.getPage(pageNumber);
      let rendered: RenderedPageImage;
      try {
        rendered = await renderPageImage(page, dpi, value.format, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ToolError) throw error;
        throw new ToolError(IMAGE_RENDER_ERROR);
      }
      if (rendered.scaledDown && !warnedForMemory) {
        warnedForMemory = true;
        onWarning?.(DEVICE_MEMORY_WARNING);
      }
      outputs.push({
        name: pageOutputName(file, pageNumber, loaded.doc.numPages, value.format),
        bytes: rendered.bytes,
        mime: value.format === 'jpg' ? 'image/jpeg' : 'image/png',
      });
      onProgress(index + 1, pages.length, index === pages.length - 1 ? 'Images ready' : `Rendered page ${pageNumber}`);
      await yieldToUi();
    }
    signal.throwIfAborted();
    return outputs;
  } finally {
    await loaded.doc.destroy();
  }
}

export const pdfToJpgTool: ToolDefinition = {
  slug: 'pdf-to-jpg', title: 'PDF to JPG',
  description: 'Turn every page, or the pages you choose, into JPG or PNG images.',
  accepts: 'pdf', multiple: false, defaultOptions: DEFAULT_PDF_TO_JPG_OPTIONS,
  Options: PdfToJpgOptions, icon: '▣', run,
};
