import type { PDFPageProxy } from 'pdfjs-dist';
import { pdfRectToScreenRect } from '@/lib/export/coordinates';
import type { PdfRect } from '@/lib/export/types';
import { encodeJpeg, type DecodedImagePixels } from '@/lib/compress/recode';
import type { GraphicsMatrix } from '@/lib/pdf/images';
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

function intersection(rects: readonly PdfRect[]): PdfRect | undefined {
  const left = Math.max(...rects.map((rect) => rect.x));
  const bottom = Math.max(...rects.map((rect) => rect.y));
  const right = Math.min(...rects.map((rect) => rect.x + rect.w));
  const top = Math.min(...rects.map((rect) => rect.y + rect.h));
  return right > left && top > bottom
    ? { x: left, y: bottom, w: right - left, h: top - bottom }
    : undefined;
}

function pixelInterval(
  start: number,
  end: number,
  size: number,
): { readonly start: number; readonly end: number } {
  const first = Math.max(0, Math.min(size - 1, Math.floor(start * size + 1e-9)));
  const last = Math.max(first + 1, Math.min(size, Math.ceil(end * size - 1e-9)));
  return { start: first, end: last };
}

/**
 * Map an axis-aligned PDF crop back into the original image samples. PDF rectangles are
 * bottom-left based while decoded image rows are top-left based. The placement signs retain
 * horizontal/vertical flips; skew or rotation deliberately returns null for the render fallback.
 */
export function sourcePixelCrop(
  placedRect: PdfRect,
  visibleRect: PdfRect,
  cropRect: PdfRect,
  pixelSize: { readonly width: number; readonly height: number },
  placement?: GraphicsMatrix,
): PixelCrop | null {
  try {
    assertRect(placedRect, 'Placed image rectangle');
    assertRect(visibleRect, 'Visible image rectangle');
    assertRect(cropRect, 'Crop rectangle');
  } catch {
    return null;
  }
  if (
    !placement ||
    placement.some((value) => !Number.isFinite(value)) ||
    Math.abs(placement[1]) > 0.01 ||
    Math.abs(placement[2]) > 0.01 ||
    Math.abs(placement[0]) <= 0.01 ||
    Math.abs(placement[3]) <= 0.01 ||
    !Number.isFinite(pixelSize.width) ||
    !Number.isFinite(pixelSize.height) ||
    pixelSize.width <= 0 ||
    pixelSize.height <= 0
  ) return null;

  const clipped = intersection([placedRect, visibleRect, cropRect]);
  if (!clipped) return null;
  const left = (clipped.x - placedRect.x) / placedRect.w;
  const right = (clipped.x + clipped.w - placedRect.x) / placedRect.w;
  const bottom = (clipped.y - placedRect.y) / placedRect.h;
  const top = (clipped.y + clipped.h - placedRect.y) / placedRect.h;
  const x = placement[0] > 0
    ? pixelInterval(left, right, pixelSize.width)
    : pixelInterval(1 - right, 1 - left, pixelSize.width);
  const y = placement[3] < 0
    ? pixelInterval(1 - top, 1 - bottom, pixelSize.height)
    : pixelInterval(bottom, top, pixelSize.height);
  return { left: x.start, top: y.start, width: x.end - x.start, height: y.end - y.start };
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

function canvasPixels(canvas: HTMLCanvasElement, originalBytes: number): DecodedImagePixels {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas context unavailable for image crop.');
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    data: new Uint8ClampedArray(image.data),
    width: canvas.width,
    height: canvas.height,
    originalBytes,
  };
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
    const pixels = canvasPixels(canvas, bytes.byteLength);
    const transparent = pixels.data.some((value, index) => index % 4 === 3 && value < 255);
    return transparent
      ? await canvasPngBytes(canvas)
      : await encodeJpeg(pixels, { width: pixels.width, height: pixels.height }, 0.9);
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
  await page.render({ canvasContext: pageContext, viewport, intent: 'print' }).promise;

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
