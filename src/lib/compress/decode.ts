import { PDFName, PDFRawStream, PDFRef, type PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { extractImageBytes, extractImageBytesByRef } from '@/lib/images/extractImage';
import type { CompressImageAnalysis } from './analyze';
import type { DecodedImagePixels } from './recode';

function canvasPixels(source: CanvasImageSource, width: number, height: number, originalBytes: number): DecodedImagePixels {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable.');
    context.drawImage(source, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    return { data: new Uint8ClampedArray(image.data), width, height, originalBytes };
  } finally { canvas.width = canvas.height = 0; }
}

async function decodeExtracted(document: PDFDocument, image: CompressImageAnalysis): Promise<DecodedImagePixels | undefined> {
  if (!image.occurrence || typeof createImageBitmap === 'undefined') return undefined;
  const extracted = image.ref
    ? extractImageBytesByRef(document, PDFRef.of(image.ref.objectNumber, image.ref.generationNumber))
    : extractImageBytes(document, image.occurrence.pageIndex, image.occurrence.rect);
  if (!extracted) return undefined;
  const bitmap = await createImageBitmap(new Blob([extracted.bytes.slice().buffer], { type: extracted.mime }));
  try { return canvasPixels(bitmap, bitmap.width, bitmap.height, image.streamBytes); } finally { bitmap.close(); }
}

/** Decode an image's exact soft-mask stream so it can be resized with the replacement photo. */
export async function decodeCompressSoftMask(
  document: PDFDocument,
  image: CompressImageAnalysis,
  signal: AbortSignal,
): Promise<DecodedImagePixels | undefined> {
  if (!image.ref || typeof createImageBitmap === 'undefined') return undefined;
  signal.throwIfAborted();
  const imageRef = PDFRef.of(image.ref.objectNumber, image.ref.generationNumber);
  const imageStream = document.context.lookup(imageRef);
  if (!(imageStream instanceof PDFRawStream)) return undefined;
  const maskRef = imageStream.dict.get(PDFName.of('SMask'));
  if (!(maskRef instanceof PDFRef)) return undefined;
  const maskStream = document.context.lookup(maskRef);
  if (!(maskStream instanceof PDFRawStream)) return undefined;
  const extracted = extractImageBytesByRef(document, maskRef);
  if (!extracted) return undefined;
  const bitmap = await createImageBitmap(new Blob([extracted.bytes.slice().buffer], { type: extracted.mime }));
  try {
    signal.throwIfAborted();
    return canvasPixels(bitmap, bitmap.width, bitmap.height, maskStream.contents.length);
  } finally { bitmap.close(); }
}

function expandPixels(value: { data: ArrayLike<number>; width: number; height: number }, originalBytes: number): DecodedImagePixels | undefined {
  const pixels = value.width * value.height;
  if (!pixels || value.data.length % pixels !== 0) return undefined;
  const channels = value.data.length / pixels;
  if (![1, 3, 4].includes(channels)) return undefined;
  const output = new Uint8ClampedArray(pixels * 4);
  for (let index = 0; index < pixels; index++) {
    const source = index * channels;
    const target = index * 4;
    if (channels === 1) {
      output[target] = output[target + 1] = output[target + 2] = value.data[source] ?? 0;
    } else {
      output[target] = value.data[source] ?? 0;
      output[target + 1] = value.data[source + 1] ?? 0;
      output[target + 2] = value.data[source + 2] ?? 0;
    }
    output[target + 3] = channels === 4 ? value.data[source + 3] ?? 255 : 255;
  }
  return { data: output, width: value.width, height: value.height, originalBytes };
}

function objectStore(page: PDFPageProxy, objectId: string): { get(id: string): unknown } {
  const internal = page as unknown as { objs: { get(id: string): unknown }; commonObjs?: { get(id: string): unknown } };
  return objectId.startsWith('g_') && internal.commonObjs ? internal.commonObjs : internal.objs;
}

async function decodeFromPdfJs(
  reader: PDFDocumentProxy,
  image: CompressImageAnalysis,
): Promise<DecodedImagePixels | undefined> {
  const occurrence = image.occurrence;
  if (!occurrence?.objectId) return undefined;
  const page = await reader.getPage(occurrence.pageIndex + 1);
  try {
    await page.getOperatorList();
    const value = objectStore(page, occurrence.objectId).get(occurrence.objectId) as {
      data?: ArrayLike<number>; width?: number; height?: number; bitmap?: ImageBitmap;
    } | ImageBitmap | undefined;
    if (!value) return undefined;
    if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) {
      return canvasPixels(value, value.width, value.height, image.streamBytes);
    }
    const decoded = value as { data?: ArrayLike<number>; width?: number; height?: number; bitmap?: ImageBitmap };
    if (decoded.bitmap) {
      return canvasPixels(decoded.bitmap, decoded.bitmap.width, decoded.bitmap.height, image.streamBytes);
    }
    if (decoded.data && decoded.width && decoded.height) return expandPixels({
      data: decoded.data, width: decoded.width, height: decoded.height,
    }, image.streamBytes);
    return undefined;
  } finally { page.cleanup(); }
}

/** Decode through Task 56's exact-XObject path, then use pdf.js final colours as the safe fallback. */
export async function decodeCompressImage(
  document: PDFDocument,
  reader: PDFDocumentProxy,
  image: CompressImageAnalysis,
  signal: AbortSignal,
): Promise<DecodedImagePixels | undefined> {
  signal.throwIfAborted();
  try {
    const extracted = await decodeExtracted(document, image);
    if (extracted) return extracted;
  } catch { /* pdf.js fallback below */ }
  signal.throwIfAborted();
  return decodeFromPdfJs(reader, image);
}
