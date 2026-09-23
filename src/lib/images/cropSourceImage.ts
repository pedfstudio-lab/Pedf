import { PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { analyzePdf, type CompressAnalysis, type CompressImageAnalysis } from '@/lib/compress/analyze';
import { decodeCompressImage, decodeCompressSoftMask } from '@/lib/compress/decode';
import {
  encodeJpeg,
  resizeSoftMask,
  type DecodedImagePixels,
  type JpegEncoder,
} from '@/lib/compress/recode';
import type { PdfRect } from '@/lib/export/types';
import { matchImageXObject } from '@/lib/images/extractImage';
import { sourcePixelCrop, type PixelCrop } from '@/lib/images/imageCrop';
import type { DrawnImage } from '@/lib/pdf/images';
import { pdfjs } from '@/lib/pdf/worker';

type PngEncoder = (pixels: DecodedImagePixels) => Promise<Uint8Array>;

interface CropSourceImageServices {
  readonly analyze?: (bytes: Uint8Array, signal: AbortSignal) => Promise<CompressAnalysis>;
  readonly decode?: (
    document: PDFDocument,
    reader: PDFDocumentProxy,
    image: CompressImageAnalysis,
    signal: AbortSignal,
  ) => Promise<DecodedImagePixels | undefined>;
  readonly decodeMask?: (
    document: PDFDocument,
    image: CompressImageAnalysis,
    signal: AbortSignal,
  ) => Promise<DecodedImagePixels | undefined>;
  readonly encodeJpeg?: JpegEncoder;
  readonly encodePng?: PngEncoder;
  readonly openReader?: (bytes: Uint8Array) => Promise<PDFDocumentProxy>;
}

const analysisCache = new WeakMap<Uint8Array, Promise<CompressAnalysis>>();

function cachedAnalysis(bytes: Uint8Array): Promise<CompressAnalysis> {
  let pending = analysisCache.get(bytes);
  if (!pending) {
    pending = analyzePdf(bytes, new AbortController().signal);
    analysisCache.set(bytes, pending);
    void pending.catch(() => {
      if (analysisCache.get(bytes) === pending) analysisCache.delete(bytes);
    });
  }
  return pending;
}

/** Start the reusable PDF image analysis while the user is choosing a crop. */
export function prepareSourceImageCrops(bytes: Uint8Array): Promise<CompressAnalysis> {
  return cachedAnalysis(bytes);
}

function sameRef(
  image: CompressImageAnalysis,
  ref: { readonly objectNumber: number; readonly generationNumber: number },
): boolean {
  return image.ref?.objectNumber === ref.objectNumber
    && image.ref.generationNumber === ref.generationNumber;
}

function cropPixels(pixels: DecodedImagePixels, crop: PixelCrop): DecodedImagePixels {
  const data = new Uint8ClampedArray(crop.width * crop.height * 4);
  for (let row = 0; row < crop.height; row += 1) {
    const source = ((crop.top + row) * pixels.width + crop.left) * 4;
    const target = row * crop.width * 4;
    data.set(pixels.data.subarray(source, source + crop.width * 4), target);
  }
  return {
    data,
    width: crop.width,
    height: crop.height,
    originalBytes: pixels.originalBytes,
  };
}

function applySoftMask(
  pixels: DecodedImagePixels,
  mask: DecodedImagePixels,
  crop: PixelCrop,
): DecodedImagePixels {
  const alpha = resizeSoftMask(mask, { width: pixels.width, height: pixels.height });
  const cropped = cropPixels(pixels, crop);
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const source = (crop.top + y) * pixels.width + crop.left + x;
      cropped.data[(y * crop.width + x) * 4 + 3] = alpha[source] ?? 255;
    }
  }
  return cropped;
}

function hasTransparency(pixels: DecodedImagePixels): boolean {
  for (let offset = 3; offset < pixels.data.length; offset += 4) {
    if (pixels.data[offset] !== 255) return true;
  }
  return false;
}

async function encodePng(pixels: DecodedImagePixels): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable.');
    const image = context.createImageData(pixels.width, pixels.height);
    image.data.set(pixels.data);
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error('The cropped image could not be encoded.')),
      'image/png',
    ));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    canvas.width = canvas.height = 0;
  }
}

async function openReader(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
}

/**
 * Cut an existing PDF image from its original samples. Any uncertain identity, transform,
 * decode, mask, or encode returns undefined so callers can use the exact render fallback.
 */
export async function cropSourceImage(
  bytes: Uint8Array,
  draw: DrawnImage,
  cropRect: PdfRect,
  services: CropSourceImageServices = {},
): Promise<Uint8Array | undefined> {
  if (draw.kind !== 'image' || !draw.visibleRect || !draw.placement) return undefined;
  const signal = new AbortController().signal;
  let reader: PDFDocumentProxy | undefined;
  try {
    const [analysis, document] = await Promise.all([
      services.analyze ? services.analyze(bytes, signal) : cachedAnalysis(bytes),
      PDFDocument.load(bytes.slice(), { updateMetadata: false }),
    ]);
    const matched = matchImageXObject(document, draw.region.pageIndex, draw.region.rect);
    if (!matched?.ref) return undefined;
    const image = analysis.images.find((candidate) => sameRef(candidate, matched.ref!));
    if (!image || image.imageMask || image.hasMask || !image.ref) return undefined;

    reader = await (services.openReader ?? openReader)(bytes);
    const pixels = await (services.decode ?? decodeCompressImage)(document, reader, image, signal);
    if (!pixels) return undefined;
    const crop = sourcePixelCrop(
      draw.region.rect,
      draw.visibleRect,
      cropRect,
      { width: pixels.width, height: pixels.height },
      draw.placement,
    );
    if (!crop) return undefined;

    let cropped: DecodedImagePixels;
    if (image.hasSoftMask) {
      const mask = await (services.decodeMask ?? decodeCompressSoftMask)(document, image, signal);
      if (!mask) return undefined;
      cropped = applySoftMask(pixels, mask, crop);
    } else {
      cropped = cropPixels(pixels, crop);
    }
    return hasTransparency(cropped)
      ? await (services.encodePng ?? encodePng)(cropped)
      : await (services.encodeJpeg ?? encodeJpeg)(
          cropped,
          { width: cropped.width, height: cropped.height },
          0.9,
        );
  } catch {
    return undefined;
  } finally {
    if (reader) await reader.destroy().catch(() => undefined);
  }
}
