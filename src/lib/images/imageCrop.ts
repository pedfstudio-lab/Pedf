import type { PDFPageProxy } from 'pdfjs-dist';
import { pdfRectToScreenRect } from '@/lib/export/coordinates';
import type { PdfRect } from '@/lib/export/types';
import { imageMimeType } from './imageFile';

export interface PixelCrop {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function assertRect(rect: PdfRect, name: string): void {
  if (
    ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ||
    rect.w <= 0 ||
    rect.h <= 0
  ) {
    throw new RangeError(`${name} must be a positive finite rectangle.`);
  }
}

/** Map a bottom-left PDF crop rectangle into top-left source-image pixels. */
export function cropRectToPixels(
  imageRect: PdfRect,
  cropRect: PdfRect,
  pixelWidth: number,
  pixelHeight: number,
): PixelCrop {
  assertRect(imageRect, 'Image rectangle');
  assertRect(cropRect, 'Crop rectangle');
  if (!Number.isFinite(pixelWidth) || pixelWidth <= 0 || !Number.isFinite(pixelHeight) || pixelHeight <= 0) {
    throw new RangeError('Image pixel dimensions must be positive finite numbers.');
  }

  const imageRight = imageRect.x + imageRect.w;
  const imageTop = imageRect.y + imageRect.h;
  const cropLeft = Math.max(imageRect.x, cropRect.x);
  const cropRight = Math.min(imageRight, cropRect.x + cropRect.w);
  const cropBottom = Math.max(imageRect.y, cropRect.y);
  const cropTop = Math.min(imageTop, cropRect.y + cropRect.h);
  if (cropRight <= cropLeft || cropTop <= cropBottom) {
    throw new RangeError('Crop rectangle must overlap the image.');
  }

  const left = Math.floor((cropLeft - imageRect.x) / imageRect.w * pixelWidth);
  const right = Math.ceil((cropRight - imageRect.x) / imageRect.w * pixelWidth);
  const top = Math.floor((imageTop - cropTop) / imageRect.h * pixelHeight);
  const bottom = Math.ceil((imageTop - cropBottom) / imageRect.h * pixelHeight);
  return {
    left: Math.max(0, Math.min(pixelWidth - 1, left)),
    top: Math.max(0, Math.min(pixelHeight - 1, top)),
    width: Math.max(1, Math.min(pixelWidth, right) - Math.max(0, left)),
    height: Math.max(1, Math.min(pixelHeight, bottom) - Math.max(0, top)),
  };
}

function imageBlob(bytes: Uint8Array): Blob {
  const mime = imageMimeType(bytes);
  if (!mime) throw new Error('Unsupported image format. Choose a PNG or JPEG file.');
  return new Blob([bytes.slice().buffer], { type: mime });
}

async function decodeImage(bytes: Uint8Array): Promise<{
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  readonly dispose: () => void;
}> {
  const blob = imageBlob(bytes);
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => bitmap.close(),
    };
  }

  const url = URL.createObjectURL(blob);
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('The selected image could not be decoded.'));
    element.src = url;
  });
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    dispose: () => URL.revokeObjectURL(url),
  };
}

async function canvasPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (next) => next ? resolve(next) : reject(new Error('The cropped image could not be encoded.')),
      'image/png',
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/** Crop from the user's original encoded file, avoiding any screen-resolution resampling. */
export async function cropImageBytes(
  bytes: Uint8Array,
  imageRect: PdfRect,
  cropRect: PdfRect,
): Promise<Uint8Array> {
  const decoded = await decodeImage(bytes);
  try {
    const crop = cropRectToPixels(imageRect, cropRect, decoded.width, decoded.height);
    const canvas = document.createElement('canvas');
    canvas.width = crop.width;
    canvas.height = crop.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas context unavailable for image crop.');
    context.drawImage(
      decoded.source,
      crop.left,
      crop.top,
      crop.width,
      crop.height,
      0,
      0,
      crop.width,
      crop.height,
    );
    return await canvasPngBytes(canvas);
  } finally {
    decoded.dispose();
  }
}

/**
 * Capture an existing PDF image region from a fresh PDF.js render. This deliberately
 * bakes transparency against the page background; scale 3 is the pragmatic quality default.
 */
export async function capturePdfRegion(
  page: PDFPageProxy,
  rect: PdfRect,
  oversample = 3,
): Promise<Uint8Array> {
  if (!Number.isFinite(oversample) || oversample <= 0) {
    throw new RangeError('Oversample scale must be a positive finite number.');
  }
  const viewport = page.getViewport({ scale: oversample });
  const sourceRect = pdfRectToScreenRect(rect, viewport, 1);
  const pageCanvas = document.createElement('canvas');
  pageCanvas.width = Math.ceil(viewport.width);
  pageCanvas.height = Math.ceil(viewport.height);
  const pageContext = pageCanvas.getContext('2d');
  if (!pageContext) throw new Error('2D canvas context unavailable for PDF image capture.');
  await page.render({ canvasContext: pageContext, viewport }).promise;

  const output = document.createElement('canvas');
  output.width = Math.max(1, Math.round(sourceRect.width));
  output.height = Math.max(1, Math.round(sourceRect.height));
  const outputContext = output.getContext('2d');
  if (!outputContext) throw new Error('2D canvas context unavailable for PDF image crop.');
  outputContext.drawImage(
    pageCanvas,
    sourceRect.left,
    sourceRect.top,
    sourceRect.width,
    sourceRect.height,
    0,
    0,
    output.width,
    output.height,
  );
  pageCanvas.width = 1;
  pageCanvas.height = 1;
  return canvasPngBytes(output);
}
