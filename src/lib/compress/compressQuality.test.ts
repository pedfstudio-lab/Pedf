import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { worstBlockDiff } from '@/harness/pixelDiff';
import { pdfjs } from '@/lib/pdf/worker';
import { analyzePdf, type CompressImageAnalysis } from './analyze';
import { compressPdf } from './compressPdf';
import type { DecodedImagePixels, JpegEncoder } from './recode';

vi.mock('@/lib/pdf/worker', async () => ({ pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs') }));

const optionalCanvas = await import('@napi-rs/canvas').catch(() => undefined);
const createCanvas = optionalCanvas?.createCanvas;

function canvas(width: number, height: number) {
  if (!createCanvas) throw new Error('Optional @napi-rs/canvas is unavailable.');
  return createCanvas(width, height);
}

const encodeJpeg: JpegEncoder = async (pixels, target, quality) => {
  const source = canvas(pixels.width, pixels.height);
  const sourceContext = source.getContext('2d');
  const image = sourceContext.createImageData(pixels.width, pixels.height);
  image.data.set(pixels.data);
  sourceContext.putImageData(image, 0, 0);
  const output = canvas(target.width, target.height);
  const outputContext = output.getContext('2d');
  outputContext.fillStyle = '#fff';
  outputContext.fillRect(0, 0, target.width, target.height);
  outputContext.imageSmoothingEnabled = true;
  outputContext.imageSmoothingQuality = 'high';
  outputContext.drawImage(source, 0, 0, target.width, target.height);
  return new Uint8Array(await output.encode('jpeg', Math.round(quality * 100)));
};

async function renderPage(bytes: Uint8Array, pageNumber: number): Promise<ImageData> {
  const document = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  try {
    const page = await document.getPage(pageNumber);
    try {
      const viewport = page.getViewport({ scale: 1.5 });
      const output = canvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = output.getContext('2d');
      await page.render({
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      const rendered = context.getImageData(0, 0, output.width, output.height);
      return {
        data: new Uint8ClampedArray(rendered.data),
        width: rendered.width,
        height: rendered.height,
        colorSpace: 'srgb',
      } as ImageData;
    } finally { page.cleanup(); }
  } finally { await document.destroy(); }
}

const suiteName = optionalCanvas
  ? 'Compress PDF local visual quality'
  : 'Compress PDF local visual quality (skipped: optional @napi-rs/canvas is unavailable)';

describe.skipIf(!optionalCanvas)(suiteName, () => {
  it('keeps GOA page 2 Medium below a worst-block mean error of 12', async () => {
    const bytes = new Uint8Array(readFileSync(resolve('public/samples/GOA 2026.pdf')));
    const signal = new AbortController().signal;
    const analysis = await analyzePdf(bytes, signal);
    const result = await compressPdf(bytes, 'medium', {
      signal,
      analysis,
      onProgress: () => undefined,
      encode: encodeJpeg,
    });
    const [before, after] = await Promise.all([renderPage(bytes, 2), renderPage(result.bytes, 2)]);
    expect(worstBlockDiff(before, after).meanError).toBeLessThan(12);
  }, 60_000);

  it('reports zero worst-block damage for a signature-like image left untouched', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([240, 160]);
    const width = 120;
    const height = 64;
    const alpha = new Uint8Array(width * height);
    const rgb = new Uint8Array(width * height * 3).fill(255);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const stroke = Math.abs(y - (18 + Math.sin(x / 9) * 9)) < 2;
      alpha[y * width + x] = stroke ? 255 : 0;
      if (stroke) rgb.fill(15, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
    const mask = document.context.flateStream(alpha, {
      Type: 'XObject', Subtype: 'Image', Width: width, Height: height,
      ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    });
    const maskRef = document.context.register(mask);
    const signature = document.context.flateStream(rgb, {
      Type: 'XObject', Subtype: 'Image', Width: width, Height: height,
      ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: maskRef,
    });
    const signatureRef = document.context.register(signature);
    const name = page.node.newXObject('Signature', signatureRef);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(120, 0, 0, 64, 50, 45),
      drawObject(name), popGraphicsState());
    const bytes = await document.save({ useObjectStreams: true });
    const signal = new AbortController().signal;
    const analysis = await analyzePdf(bytes, signal);
    const decoded: DecodedImagePixels = {
      data: new Uint8ClampedArray(width * height * 4), width, height, originalBytes: signature.contents.length,
    };
    for (let index = 0; index < width * height; index++) {
      decoded.data.set([rgb[index * 3]!, rgb[index * 3 + 1]!, rgb[index * 3 + 2]!, alpha[index]!], index * 4);
    }
    const encode = vi.fn(encodeJpeg);
    const result = await compressPdf(bytes, 'smallest', {
      signal,
      analysis,
      onProgress: () => undefined,
      decode: async (_pdf, _reader, image: CompressImageAnalysis) => ({
        ...decoded,
        originalBytes: image.streamBytes,
      }),
      encode,
    });
    const [before, after] = await Promise.all([renderPage(bytes, 1), renderPage(result.bytes, 1)]);
    expect(worstBlockDiff(before, after)).toEqual({ meanError: 0, changedPercent: 0 });
    expect(encode).not.toHaveBeenCalled();
  }, 30_000);

  it('keeps a differently-sized original soft mask transparent after resizing its photo', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([240, 240]);
    const source = canvas(800, 800);
    const context = source.getContext('2d');
    const imageData = context.createImageData(800, 800);
    for (let y = 0; y < 800; y++) for (let x = 0; x < 800; x++) {
      const offset = (y * 800 + x) * 4;
      imageData.data[offset] = 30 + Math.round(x / 4);
      imageData.data[offset + 1] = 40 + Math.round(y / 5);
      imageData.data[offset + 2] = 180 - Math.round(x / 8);
      imageData.data[offset + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);
    const photoBytes = new Uint8Array(await source.encode('jpeg', 100));
    const maskPixels = Uint8Array.from({ length: 20 * 20 }, (_, index) =>
      Math.round((index % 20) / 19 * 255));
    const maskRef = document.context.register(document.context.flateStream(maskPixels, {
      Type: 'XObject', Subtype: 'Image', Width: 20, Height: 20,
      ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    }));
    const photoRef = document.context.register(PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 800, Height: 800,
      ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode', SMask: maskRef,
    }), photoBytes));
    const photoName = page.node.newXObject('Photo', photoRef);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(200, 0, 0, 200, 20, 20),
      drawObject(photoName), popGraphicsState());
    const bytes = await document.save({ useObjectStreams: true });
    const signal = new AbortController().signal;
    const analysis = await analyzePdf(bytes, signal);
    const result = await compressPdf(bytes, 'smallest', {
      signal, analysis, onProgress: () => undefined, encode: encodeJpeg,
      decode: async () => ({
        data: new Uint8ClampedArray(imageData.data), width: 800, height: 800, originalBytes: photoBytes.length,
      }),
      decodeSoftMask: async () => undefined,
    });
    expect(result.madeSmaller).toBe(1);
    const reopened = await PDFDocument.load(result.bytes, { updateMetadata: false });
    const main = reopened.context.lookup(photoRef);
    if (!(main instanceof PDFRawStream)) throw new Error('compressed photo missing');
    expect(main.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(222);
    const keptMaskRef = main.dict.get(PDFName.of('SMask'));
    expect(keptMaskRef).toBeInstanceOf(PDFRef);
    if (!(keptMaskRef instanceof PDFRef)) throw new Error('soft mask missing');
    const keptMask = reopened.context.lookup(keptMaskRef);
    if (!(keptMask instanceof PDFRawStream)) throw new Error('soft mask stream missing');
    expect(keptMask.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(20);
    const [before, after] = await Promise.all([renderPage(bytes, 1), renderPage(result.bytes, 1)]);
    expect(worstBlockDiff(before, after).meanError).toBeLessThan(12);
  }, 60_000);

  it('keeps a JPEG-encoded document scan readable at Smallest', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([288, 384]);
    const source = canvas(1_200, 1_600);
    const context = source.getContext('2d');
    const imageData = context.createImageData(1_200, 1_600);
    for (let y = 0; y < 1_600; y++) for (let x = 0; x < 1_200; x++) {
      const offset = (y * 1_200 + x) * 4;
      const ink = x > 80 && x < 1_120 && y % 38 < 4;
      const value = ink ? 18 + ((x + y) % 24) : 225 + ((x * 3 + y * 5) % 28);
      imageData.data[offset] = value + 2;
      imageData.data[offset + 1] = value;
      imageData.data[offset + 2] = value - 2;
      imageData.data[offset + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);
    const scan = await document.embedJpg(new Uint8Array(await source.encode('jpeg', 80)));
    page.drawImage(scan, { x: 0, y: 0, width: 288, height: 384 });
    const bytes = await document.save({ useObjectStreams: true });
    const signal = new AbortController().signal;
    const analysis = await analyzePdf(bytes, signal);
    const result = await compressPdf(bytes, 'smallest', {
      signal, analysis, onProgress: () => undefined, encode: encodeJpeg,
    });
    const reopened = await PDFDocument.load(result.bytes, { updateMetadata: false });
    const main = reopened.context.lookup(scan.ref);
    if (!(main instanceof PDFRawStream)) throw new Error('compressed scan missing');
    expect(main.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(800);
    const [before, after] = await Promise.all([renderPage(bytes, 1), renderPage(result.bytes, 1)]);
    expect(worstBlockDiff(before, after).meanError).toBeLessThan(12);
  }, 60_000);
});
