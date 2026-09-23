import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { describe, expect, it, vi } from 'vitest';
import { analyzePdf, type CompressImageAnalysis } from '@/lib/compress/analyze';
import { decodeCompressImage } from '@/lib/compress/decode';
import type { JpegEncoder } from '@/lib/compress/recode';
import { replacedImageFor } from '@/lib/edit/replacedImage';
import { exportPdf } from '@/lib/export/exportPdf';
import type { EditDocument, ImageEdit, PdfRect } from '@/lib/export/types';
import { cropSourceImage } from '@/lib/images/cropSourceImage';
import { imageDrawsFromOperatorList } from '@/lib/pdf/images';

vi.mock('@/lib/pdf/worker', async () => ({ pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs') }));

const roots = ['tmp/image-removal', 'tmp/compress-tests'];
const vietnamPath = "tmp/image-removal/Vietnam Sept'26.pdf";
const optionalCanvas = await import('@napi-rs/canvas').catch(() => undefined);
const enabled = process.env.TASK71_REAL === '1' && existsSync(vietnamPath);
if (!enabled) {
  process.stdout.write(
    'Task 71 real crop checks skipped: set TASK71_REAL=1 with tmp/image-removal fixtures present.\n',
  );
}

async function pdfFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await pdfFiles(path));
    else if (entry.isFile() && /\.pdf$/i.test(entry.name)) files.push(path);
  }
  return files;
}

async function resolveReaderImage(
  reader: PDFDocumentProxy,
  image: CompressImageAnalysis,
): Promise<void> {
  const occurrence = image.occurrence;
  if (!occurrence?.objectId) return;
  const page = await reader.getPage(occurrence.pageIndex + 1);
  await page.getOperatorList();
  const internal = page as unknown as {
    cleanup: () => void;
    objs: { get(id: string, callback: (value: unknown) => void): null };
    commonObjs?: { get(id: string, callback: (value: unknown) => void): null };
  };
  internal.cleanup = () => undefined;
  const store = occurrence.objectId.startsWith('g_') && internal.commonObjs
    ? internal.commonObjs : internal.objs;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('pdf.js image object did not resolve')), 1_000);
    store.get(occurrence.objectId!, () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function canvas(width: number, height: number) {
  if (!optionalCanvas) throw new Error('Optional @napi-rs/canvas is unavailable.');
  return optionalCanvas.createCanvas(width, height);
}

const encodeJpeg: JpegEncoder = async (pixels, target, quality) => {
  const source = canvas(pixels.width, pixels.height);
  const sourceContext = source.getContext('2d');
  const sourceImage = sourceContext.createImageData(pixels.width, pixels.height);
  sourceImage.data.set(pixels.data);
  sourceContext.putImageData(sourceImage, 0, 0);
  const output = canvas(target.width, target.height);
  output.getContext('2d').drawImage(source, 0, 0, target.width, target.height);
  return new Uint8Array(await output.encode('jpeg', Math.round(quality * 100)));
};

function sameRect(left: PdfRect, right: PdfRect, tolerance = 0.5): boolean {
  return ['x', 'y', 'w', 'h'].every((key) => (
    Math.abs(left[key as keyof PdfRect] - right[key as keyof PdfRect]) <= tolerance
  ));
}

async function pageGeometry(reader: PDFDocumentProxy): Promise<EditDocument['pages']> {
  return Promise.all(Array.from({ length: reader.numPages }, async (_, pageIndex) => {
    const page = await reader.getPage(pageIndex + 1);
    const [left = 0, bottom = 0, right = 0, top = 0] = page.view;
    return {
      pageIndex,
      widthPt: right - left,
      heightPt: top - bottom,
      rotation: ((page.rotate % 360) + 360) % 360 as 0 | 90 | 180 | 270,
      boxOffset: { x: left, y: bottom },
    };
  }));
}

async function capturePdfRegionNative(
  page: PDFPageProxy,
  rect: PdfRect,
  oversample = 3,
): Promise<Uint8Array> {
  const viewport = page.getViewport({ scale: oversample });
  const pageCanvas = canvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const pageContext = pageCanvas.getContext('2d');
  await page.render({
    canvasContext: pageContext as unknown as CanvasRenderingContext2D,
    viewport,
    intent: 'print',
  }).promise;
  const [left, top] = viewport.convertToViewportPoint(rect.x, rect.y + rect.h);
  const [right, bottom] = viewport.convertToViewportPoint(rect.x + rect.w, rect.y);
  const output = canvas(
    Math.max(1, Math.round(Math.abs(right - left))),
    Math.max(1, Math.round(Math.abs(bottom - top))),
  );
  output.getContext('2d').drawImage(
    pageCanvas,
    Math.min(left, right),
    Math.min(top, bottom),
    Math.abs(right - left),
    Math.abs(bottom - top),
    0,
    0,
    output.width,
    output.height,
  );
  return new Uint8Array(await output.encode('png'));
}

async function renderPage(bytes: Uint8Array, pageNumber: number): Promise<ImageData> {
  const reader = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  try {
    const page = await reader.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 150 / 72 });
    const output = canvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = output.getContext('2d');
    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    const image = context.getImageData(0, 0, output.width, output.height);
    return {
      data: new Uint8ClampedArray(image.data),
      width: image.width,
      height: image.height,
      colorSpace: 'srgb',
    } as ImageData;
  } finally {
    await reader.destroy();
  }
}

function cropMeanError(
  left: ImageData,
  right: ImageData,
  rect: PdfRect,
  page: EditDocument['pages'][number],
): number {
  expect([right.width, right.height]).toEqual([left.width, left.height]);
  const scale = 150 / 72;
  const x0 = Math.max(0, Math.floor((rect.x - page.boxOffset.x) * scale));
  const x1 = Math.min(left.width, Math.ceil((rect.x - page.boxOffset.x + rect.w) * scale));
  const y0 = Math.max(0, Math.floor((page.heightPt - (rect.y - page.boxOffset.y) - rect.h) * scale));
  const y1 = Math.min(left.height, Math.ceil((page.heightPt - (rect.y - page.boxOffset.y)) * scale));
  let error = 0;
  let samples = 0;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    const offset = (y * left.width + x) * 4;
    error += Math.abs(left.data[offset]! - right.data[offset]!);
    error += Math.abs(left.data[offset + 1]! - right.data[offset + 1]!);
    error += Math.abs(left.data[offset + 2]! - right.data[offset + 2]!);
    samples += 3;
  }
  return samples ? error / (samples * 255) : Number.POSITIVE_INFINITY;
}

describe.skipIf(!enabled)('Task 71 real source-image crop checks', () => {
  it('decodes every reachable photo and finds the original Vietnam page-five pixels', async () => {
    const files = (await Promise.all(roots.map(pdfFiles))).flat().sort();
    let vietnamFound = false;
    let photos = 0;
    let decodedPhotos = 0;

    for (const file of files) {
      const bytes = new Uint8Array(await readFile(file));
      const signal = new AbortController().signal;
      const analysis = await analyzePdf(bytes, signal);
      const document = await PDFDocument.load(bytes, { updateMetadata: false });
      const reader = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
      try {
        const images = analysis.images.filter((image) => (
          !image.imageMask && image.width > 0 && image.height > 0 && image.occurrence
        ));
        for (const image of images) {
          photos += 1;
          let decoded;
          try {
            await resolveReaderImage(reader, image);
            decoded = await decodeCompressImage(document, reader, image, signal);
          } catch { /* This image uses the production fallback path. */ }
          if (decoded) decodedPhotos += 1;
          process.stdout.write(
            `TASK71 DECODE ${file} | p.${(image.occurrence?.pageIndex ?? -1) + 1}`
            + ` | ${image.ref ? `${image.ref.objectNumber}:${image.ref.generationNumber}` : image.id}`
            + ` | source ${image.width}x${image.height}`
            + ` | ${decoded ? `decoded ${decoded.width}x${decoded.height}` : 'fallback'}\n`,
          );

          if (
            file === vietnamPath
            && image.occurrence?.pageIndex === 4
            && image.ref?.objectNumber === 79
            && image.width === 663
            && image.height === 883
            && image.filters.includes('DCTDecode')
          ) {
            vietnamFound = true;
            expect(decoded).toBeDefined();
            expect(decoded && [decoded.width, decoded.height]).toEqual([663, 883]);
          }
        }
      } finally {
        await reader.destroy();
      }
    }

    process.stdout.write(
      `TASK71 DECODE TOTAL files ${files.length}, photos ${photos}, decoded ${decodedPhotos}, fallback ${photos - decodedPhotos}\n`,
    );
    expect(vietnamFound, 'Vietnam page-5 object 79 should be present').toBe(true);
  }, 600_000);

  it.skipIf(!optionalCanvas)('cuts and exports the Vietnam page-five photo from its source JPEG', async () => {
    const originalBytes = new Uint8Array(await readFile(vietnamPath));
    const signal = new AbortController().signal;
    const analysis = await analyzePdf(originalBytes, signal);
    const image = analysis.images.find((entry) => (
      entry.ref?.objectNumber === 79
      && entry.occurrence?.pageIndex === 4
      && entry.width === 663
      && entry.height === 883
    ));
    expect(image, 'Vietnam page-5 object 79 should be analyzable').toBeDefined();
    if (!image) return;

    const pdf = await PDFDocument.load(originalBytes, { updateMetadata: false });
    const reader = await getDocument({ data: originalBytes.slice(), verbosity: 0 }).promise;
    try {
      const page = await reader.getPage(5);
      const draws = imageDrawsFromOperatorList(
        await page.getOperatorList(),
        page.getViewport({ scale: 1 }),
        4,
      );
      const draw = draws.find((candidate) => (
        candidate.kind === 'image'
        && (
          candidate.objectId === image.occurrence?.objectId
          || (image.occurrence && sameRect(candidate.region.rect, image.occurrence.rect))
        )
      ));
      expect(draw?.visibleRect, 'Vietnam page-5 object 79 should have a visible draw').toBeDefined();
      if (!draw?.visibleRect) return;
      await resolveReaderImage(reader, image);
      const decoded = await decodeCompressImage(pdf, reader, image, signal);
      expect(decoded && [decoded.width, decoded.height]).toEqual([663, 883]);
      if (!decoded) return;

      const cropRect = {
        x: draw.visibleRect.x,
        y: draw.visibleRect.y,
        w: draw.visibleRect.w / 2,
        h: draw.visibleRect.h,
      };
      const started = performance.now();
      const cropped = await cropSourceImage(originalBytes, draw, cropRect, {
        analyze: async () => analysis,
        decode: async () => decoded,
        encodeJpeg,
        openReader: async () => ({ destroy: async () => undefined } as unknown as PDFDocumentProxy),
      });
      const elapsed = performance.now() - started;
      expect(cropped?.slice(0, 2)).toEqual(Uint8Array.of(0xff, 0xd8));
      expect(cropped?.byteLength).toBeLessThan(600_000);
      if (!cropped) return;

      const oldCapture = await capturePdfRegionNative(page, cropRect, 3);
      const pages = await pageGeometry(reader);
      const cover = {
        id: 'task71-cover',
        kind: 'cover' as const,
        pageIndex: 4,
        rect: { ...draw.visibleRect },
        z: 1,
        color: { r: 1, g: 1, b: 1 },
        sampleBackground: false,
        replacesImages: [replacedImageFor(
          { pageIndex: 4, rect: draw.visibleRect },
          [draw],
        )],
      };
      const imageEdit = (bytes: Uint8Array, id: string): ImageEdit => ({
        id,
        kind: 'image',
        pageIndex: 4,
        rect: cropRect,
        z: 2,
        bytes,
      });
      const [scissorsExport, oldExport] = await Promise.all([
        exportPdf({
          originalBytes,
          pages,
          edits: [cover, imageEdit(cropped, 'task71-scissors')],
        }),
        exportPdf({
          originalBytes,
          pages,
          edits: [cover, imageEdit(oldCapture, 'task71-old-capture')],
        }),
      ]);
      expect(scissorsExport.bytes.byteLength).toBeLessThan(oldExport.bytes.byteLength);
      const [scissorsRender, oldRender] = await Promise.all([
        renderPage(scissorsExport.bytes, 5),
        renderPage(oldExport.bytes, 5),
      ]);
      const error = cropMeanError(scissorsRender, oldRender, cropRect, pages[4]!);
      expect(error).toBeLessThan(0.05);
      process.stdout.write(
        `TASK71 REAL Vietnam | source ${decoded.width}x${decoded.height}`
        + ` | crop ${cropped.byteLength} bytes JPEG | old ${oldCapture.byteLength} bytes PNG`
        + ` | export ${scissorsExport.bytes.byteLength} vs ${oldExport.bytes.byteLength}`
        + ` | meanError ${error.toFixed(5)} | scissors ${elapsed.toFixed(0)} ms\n`,
      );
    } finally {
      await reader.destroy();
    }
  }, 180_000);
});
