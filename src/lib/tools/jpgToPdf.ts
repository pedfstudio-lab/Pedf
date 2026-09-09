import { PDFDocument } from 'pdf-lib';
import type { PDFImage } from 'pdf-lib';
import { JpgToPdfOptions } from '@/components/tools/JpgToPdfOptions';
import type { PdfRect } from '@/lib/export/types';
import { fitImageRect, imageMimeType, isHeic } from '@/lib/images/imageFile';
import { HEIC_GUIDANCE, isHeicFile } from './files';
import { ToolError } from './errors';
import { safeFilename, savePdf } from './pdfIo';
import {
  DEFAULT_JPG_TO_PDF_OPTIONS,
  imagesPerPageOf,
  type ImagePageMargin,
  type ImagePageOrientation,
  type ImagePageSize,
  type ImagesPerPage,
  type JpgToPdfOptionsValue,
} from './jpgToPdfOptions';
import type { ToolContext, ToolDefinition, ToolOptions, ToolOutput } from './types';

export const IMAGE_INPUT_ERROR = 'Choose at least one JPG, PNG, or WebP image.';
export const IMAGE_FORMAT_ERROR = 'Choose JPG, PNG, or WebP images.';
export const IMAGE_DECODE_ERROR = 'One of the selected images could not be read.';

/** Above this many input bytes the PDF will be large; warn, never block. */
export const LARGE_INPUT_BYTES = 100 * 1024 * 1024;
export function largeInputWarning(totalBytes: number): string {
  const mb = Math.round(totalBytes / (1024 * 1024));
  return `These images add up to about ${mb} MB, so the PDF will be large. Consider fewer photos, or use Compress PDF afterwards.`;
}

export const IMAGE_PAGE_SIZES = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
} as const;

export const IMAGE_PAGE_MARGINS = { none: 0, small: 18, big: 54 } as const;
const CSS_PIXEL_TO_POINT = 72 / 96;

export interface PreparedImage {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
}

export interface ImageBox { x: number; y: number; width: number; height: number }

export interface ImagePageLayout {
  page: { width: number; height: number };
  image: ImageBox;
}

export interface ImageGridLayout {
  page: { width: number; height: number };
  images: ImageBox[];
}

function optionsValue(options: ToolOptions): JpgToPdfOptionsValue {
  const pageSize: ImagePageSize = options.pageSize === 'a4' || options.pageSize === 'letter' ? options.pageSize : 'fit';
  const orientation: ImagePageOrientation = options.orientation === 'portrait' || options.orientation === 'landscape'
    ? options.orientation : 'auto';
  const margin: ImagePageMargin = options.margin === 'small' || options.margin === 'big' ? options.margin : 'none';
  return { pageSize, orientation, margin, imagesPerPage: imagesPerPageOf(options.imagesPerPage) };
}

function orientedSize(width: number, height: number, landscape: boolean) {
  return landscape
    ? { width: Math.max(width, height), height: Math.min(width, height) }
    : { width: Math.min(width, height), height: Math.max(width, height) };
}

function toBox(rect: PdfRect): ImageBox {
  return { x: rect.x, y: rect.y, width: rect.w, height: rect.h };
}

/** One image per page: the page hugs the image when "fit", otherwise the image is centred on the sheet. */
export function imagePageLayout(
  pixelWidth: number,
  pixelHeight: number,
  options: ToolOptions,
): ImagePageLayout {
  const value = optionsValue(options);
  const margin = IMAGE_PAGE_MARGINS[value.margin];
  const base = value.pageSize === 'fit'
    ? { width: pixelWidth * CSS_PIXEL_TO_POINT + margin * 2, height: pixelHeight * CSS_PIXEL_TO_POINT + margin * 2 }
    : IMAGE_PAGE_SIZES[value.pageSize];
  const landscape = value.orientation === 'auto' ? pixelWidth > pixelHeight : value.orientation === 'landscape';
  const page = orientedSize(base.width, base.height, landscape);
  const target = { x: margin, y: margin, w: page.width - margin * 2, h: page.height - margin * 2 };
  return { page, image: toBox(fitImageRect(target, pixelWidth, pixelHeight)) };
}

/**
 * Cell rectangles for 1, 2 or 4 images on a page, in reading order (top-left first).
 * `gap` is the space between cells and between the cells and the page edge.
 * Two images stack on a portrait page and sit side by side on a landscape page.
 */
export function gridCells(page: { width: number; height: number }, count: ImagesPerPage, gap: number): PdfRect[] {
  const columns = count === 1 ? 1 : count === 4 ? 2 : (page.width > page.height ? 2 : 1);
  const rows = count / columns;
  const cellWidth = (page.width - gap * (columns + 1)) / columns;
  const cellHeight = (page.height - gap * (rows + 1)) / rows;
  const cells: PdfRect[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      cells.push({
        x: gap + column * (cellWidth + gap),
        y: page.height - gap - (row + 1) * cellHeight - row * gap,
        w: cellWidth,
        h: cellHeight,
      });
    }
  }
  return cells;
}

/**
 * Several images per page. "Fit to image" has no meaning for a grid, so grids use A4 unless
 * Letter is chosen. Auto orientation picks the sheet whose cells match most of the photos.
 */
export function imageGridLayout(
  images: readonly { width: number; height: number }[],
  options: ToolOptions,
): ImageGridLayout {
  const value = optionsValue(options);
  const first = images[0];
  if (!first) throw new ToolError(IMAGE_INPUT_ERROR);
  if (value.imagesPerPage === 1) {
    const single = imagePageLayout(first.width, first.height, options);
    return { page: single.page, images: [single.image] };
  }
  const gap = IMAGE_PAGE_MARGINS[value.margin];
  const base = value.pageSize === 'letter' ? IMAGE_PAGE_SIZES.letter : IMAGE_PAGE_SIZES.a4;
  const landscapePhotos = images.filter((image) => image.width > image.height).length;
  const mostlyLandscape = landscapePhotos * 2 > images.length;
  // 2-up: landscape photos stack on a portrait sheet, portrait photos sit side by side on a landscape sheet.
  // 4-up (2×2): each cell has the sheet's own orientation, so match the photos directly.
  const autoLandscape = value.imagesPerPage === 2 ? !mostlyLandscape : mostlyLandscape;
  const landscape = value.orientation === 'auto' ? autoLandscape : value.orientation === 'landscape';
  const page = orientedSize(base.width, base.height, landscape);
  const cells = gridCells(page, value.imagesPerPage, gap);
  return {
    page,
    images: images.map((image, index) => toBox(fitImageRect(cells[index]!, image.width, image.height))),
  };
}

async function canvasBlob(canvas: HTMLCanvasElement, mime: 'image/png' | 'image/jpeg'): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new ToolError(IMAGE_DECODE_ERROR)),
    mime,
    mime === 'image/jpeg' ? 0.94 : undefined,
  ));
}

async function decodeWithOrientation(file: File, bytes: Uint8Array, mime: 'image/jpeg' | 'image/webp'): Promise<PreparedImage> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') throw new ToolError(IMAGE_DECODE_ERROR);
  let bitmap: ImageBitmap;
  try {
    const source = new File([bytes.slice().buffer], file.name, { type: mime });
    bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
  } catch {
    throw new ToolError(IMAGE_DECODE_ERROR);
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new ToolError(IMAGE_DECODE_ERROR);
    context.drawImage(bitmap, 0, 0);
    const outputMime = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await canvasBlob(canvas, outputMime);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: outputMime };
  } finally {
    bitmap.close();
  }
}

export async function prepareImageForPdf(file: File): Promise<PreparedImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isHeicFile(file) || isHeic(bytes)) throw new ToolError(HEIC_GUIDANCE);
  const mime = imageMimeType(bytes);
  if (!mime) throw new ToolError(IMAGE_FORMAT_ERROR);
  if (mime === 'image/png') return { bytes, mime };
  return decodeWithOrientation(file, bytes, mime);
}

function outputFilename(files: File[]): string {
  if (files.length !== 1) return 'images.pdf';
  const stem = safeFilename(files[0]!.name).replace(/\.[^.]+$/, '') || 'image';
  return `${stem}.pdf`;
}

export async function run(inputs: File[], options: ToolOptions, ctx: ToolContext): Promise<ToolOutput[]> {
  const { signal, onProgress, onWarning } = ctx;
  signal.throwIfAborted();
  if (!inputs.length) throw new ToolError(IMAGE_INPUT_ERROR);
  const totalBytes = inputs.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > LARGE_INPUT_BYTES) onWarning?.(largeInputWarning(totalBytes));

  const perPage = imagesPerPageOf(options.imagesPerPage);
  const pdf = await PDFDocument.create();
  let done = 0;
  for (let start = 0; start < inputs.length; start += perPage) {
    const group = inputs.slice(start, start + perPage);
    // Images are decoded and embedded one at a time so a long list never sits in memory at once.
    const embedded: PDFImage[] = [];
    for (const file of group) {
      signal.throwIfAborted();
      onProgress(done, inputs.length, `Adding ${file.name}`);
      const prepared = await prepareImageForPdf(file);
      signal.throwIfAborted();
      embedded.push(prepared.mime === 'image/jpeg'
        ? await pdf.embedJpg(prepared.bytes)
        : await pdf.embedPng(prepared.bytes));
      done += 1;
      onProgress(done, inputs.length, done === inputs.length ? 'Preparing PDF…' : `Added ${file.name}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const layout = imageGridLayout(embedded.map((image) => ({ width: image.width, height: image.height })), options);
    const page = pdf.addPage([layout.page.width, layout.page.height]);
    embedded.forEach((image, index) => page.drawImage(image, layout.images[index]!));
  }
  signal.throwIfAborted();
  const bytes = await savePdf(pdf);
  signal.throwIfAborted();
  onProgress(inputs.length, inputs.length, 'PDF ready');
  return [{ name: outputFilename(inputs), bytes, mime: 'application/pdf' }];
}

export const jpgToPdfTool: ToolDefinition = {
  slug: 'jpg-to-pdf', title: 'JPG to PDF',
  description: 'Turn JPG, PNG, or WebP images into one PDF, in the order you choose.',
  accepts: 'image', multiple: true, defaultOptions: DEFAULT_JPG_TO_PDF_OPTIONS,
  Options: JpgToPdfOptions, icon: '▧', run,
};
