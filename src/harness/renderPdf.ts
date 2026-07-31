import { pdfjs } from '@/lib/pdf/worker';

/** Render every page at a fixed scale and DPR 1 for reproducible pixel comparisons. */
export async function renderPdfToImageData(
  bytes: Uint8Array,
  scale = 1.5,
): Promise<ImageData[]> {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError('render scale must be a positive finite number');
  }

  const document = await pdfjs.getDocument({ data: bytes.slice() }).promise;

  try {
    const rendered: ImageData[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error(`2D canvas unavailable for page ${pageNumber}`);

      await page.render({ canvasContext: context, viewport }).promise;
      rendered.push(context.getImageData(0, 0, canvas.width, canvas.height));
      page.cleanup();
    }

    return rendered;
  } finally {
    await document.destroy();
  }
}
