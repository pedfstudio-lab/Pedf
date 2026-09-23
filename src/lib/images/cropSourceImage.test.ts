import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  PDFName,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { describe, expect, it, vi } from 'vitest';
import type { DecodedImagePixels, JpegEncoder } from '@/lib/compress/recode';
import type { DrawnImage } from '@/lib/pdf/images';
import { cropSourceImage } from './cropSourceImage';

vi.mock('@/lib/pdf/worker', async () => ({ pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs') }));

const optionalCanvas = await import('@napi-rs/canvas').catch(() => undefined);
const createCanvas = optionalCanvas?.createCanvas;
const loadImage = optionalCanvas?.loadImage;

function canvas(width: number, height: number) {
  if (!createCanvas) throw new Error('Optional @napi-rs/canvas is unavailable.');
  return createCanvas(width, height);
}

async function jpegEncoder(
  pixels: DecodedImagePixels,
  target: { readonly width: number; readonly height: number },
  quality: number,
): Promise<Uint8Array> {
  const source = canvas(pixels.width, pixels.height);
  const sourceContext = source.getContext('2d');
  const image = sourceContext.createImageData(pixels.width, pixels.height);
  image.data.set(pixels.data);
  sourceContext.putImageData(image, 0, 0);
  const output = canvas(target.width, target.height);
  output.getContext('2d').drawImage(source, 0, 0, target.width, target.height);
  return new Uint8Array(await output.encode('jpeg', Math.round(quality * 100)));
}

async function pngEncoder(pixels: DecodedImagePixels): Promise<Uint8Array> {
  const output = canvas(pixels.width, pixels.height);
  const context = output.getContext('2d');
  const image = context.createImageData(pixels.width, pixels.height);
  image.data.set(pixels.data);
  context.putImageData(image, 0, 0);
  return new Uint8Array(await output.encode('png'));
}

async function decodedPixels(bytes: Uint8Array): Promise<DecodedImagePixels> {
  if (!loadImage) throw new Error('Optional @napi-rs/canvas is unavailable.');
  const image = await loadImage(Buffer.from(bytes));
  const output = canvas(image.width, image.height);
  const context = output.getContext('2d');
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;
  return {
    data: new Uint8ClampedArray(data),
    width: image.width,
    height: image.height,
    originalBytes: bytes.byteLength,
  };
}

function fakeReader(): PDFDocumentProxy {
  return { destroy: async () => undefined } as unknown as PDFDocumentProxy;
}

function draw(
  rect = { x: 20, y: 20, w: 80, h: 60 },
  pageHeight = 100,
): DrawnImage {
  return {
    region: { pageIndex: 0, rect },
    visibleRect: rect,
    placement: [rect.w, 0, 0, -rect.h, rect.x, pageHeight - rect.y],
    widthPt: rect.w,
    heightPt: rect.h,
    objectId: 'img_p0_1',
    kind: 'image',
  };
}

async function photoPdf(): Promise<{
  readonly bytes: Uint8Array;
  readonly source: DecodedImagePixels;
  readonly imageDraw: DrawnImage;
}> {
  const width = 320;
  const height = 480;
  const sourceCanvas = canvas(width, height);
  const context = sourceCanvas.getContext('2d');
  const image = context.createImageData(width, height);
  let seed = 0x12345678;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    image.data[offset] = seed & 0xff;
    image.data[offset + 1] = (seed >>> 8) & 0xff;
    image.data[offset + 2] = (seed >>> 16) & 0xff;
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const jpeg = new Uint8Array(await sourceCanvas.encode('jpeg', 95));
  const source = await decodedPixels(jpeg);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const pageHeight = 600;
  const rect = { x: 20, y: 20, w: 300, h: 520 };
  const page = pdf.addPage([360, pageHeight]);
  page.drawImage(await pdf.embedJpg(jpeg), {
    x: rect.x, y: rect.y, width: rect.w, height: rect.h,
  });
  return {
    bytes: await pdf.save({ useObjectStreams: false }),
    source,
    imageDraw: draw(rect, pageHeight),
  };
}

function leftHalf(pixels: DecodedImagePixels): DecodedImagePixels {
  const width = pixels.width / 2;
  const data = new Uint8ClampedArray(width * pixels.height * 4);
  for (let y = 0; y < pixels.height; y += 1) {
    data.set(
      pixels.data.subarray(y * pixels.width * 4, (y * pixels.width + width) * 4),
      y * width * 4,
    );
  }
  return { data, width, height: pixels.height, originalBytes: pixels.originalBytes };
}

function meanError(left: DecodedImagePixels, right: DecodedImagePixels): number {
  expect({ width: right.width, height: right.height }).toEqual({
    width: left.width,
    height: left.height,
  });
  let error = 0;
  for (let index = 0; index < left.data.length; index += 4) {
    error += Math.abs(left.data[index]! - right.data[index]!);
    error += Math.abs(left.data[index + 1]! - right.data[index + 1]!);
    error += Math.abs(left.data[index + 2]! - right.data[index + 2]!);
  }
  return error / (left.width * left.height * 3 * 255);
}

const suiteName = optionalCanvas
  ? 'cropSourceImage'
  : 'cropSourceImage (skipped: optional @napi-rs/canvas is unavailable)';

describe.skipIf(!optionalCanvas)(suiteName, () => {
  it('cuts a generated JPEG at source resolution instead of photographing the page', async () => {
    const generated = await photoPdf();
    const encoder = vi.fn<JpegEncoder>(jpegEncoder);
    const result = await cropSourceImage(
      generated.bytes,
      generated.imageDraw,
      { x: 20, y: 20, w: 150, h: 520 },
      {
        decode: async () => generated.source,
        encodeJpeg: encoder,
        openReader: async () => fakeReader(),
      },
    );
    expect(result?.slice(0, 2)).toEqual(Uint8Array.of(0xff, 0xd8));
    if (!result) throw new Error('Expected a source-image JPEG crop.');
    const output = await decodedPixels(result);
    expect(output.width).toBeCloseTo(160, 0);
    expect(output.height).toBeCloseTo(480, 0);

    const oldCapture = canvas(450, 1560);
    const oldContext = oldCapture.getContext('2d');
    const sourceCanvas = canvas(generated.source.width, generated.source.height);
    const sourceContext = sourceCanvas.getContext('2d');
    const sourceImage = sourceContext.createImageData(generated.source.width, generated.source.height);
    sourceImage.data.set(generated.source.data);
    sourceContext.putImageData(sourceImage, 0, 0);
    oldContext.drawImage(sourceCanvas, 0, 0, 160, 480, 0, 0, 450, 1560);
    const oldBytes = new Uint8Array(await oldCapture.encode('png'));
    expect(result.byteLength).toBeLessThan(oldBytes.byteLength / 4);
    expect(meanError(leftHalf(generated.source), output)).toBeLessThan(0.05);
    expect(encoder).toHaveBeenCalledWith(expect.any(Object), { width: 160, height: 480 }, 0.9);
  }, 30_000);

  it('crops and resizes a soft mask into PNG alpha', async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const page = pdf.addPage([120, 100]);
    const softMask = pdf.context.flateStream(Uint8Array.from([
      0, 64, 128, 192, 255,
      0, 64, 128, 192, 255,
      0, 64, 128, 192, 255,
      0, 64, 128, 192, 255,
    ]), {
      Type: 'XObject', Subtype: 'Image', Width: 5, Height: 4,
      ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    });
    const imageStream = pdf.context.flateStream(new Uint8Array(10 * 8 * 3).fill(255), {
      Type: 'XObject', Subtype: 'Image', Width: 10, Height: 8,
      ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
      SMask: pdf.context.register(softMask),
    });
    const imageRef = pdf.context.register(imageStream);
    const imageName = PDFName.of('Task71Image');
    page.node.setXObject(imageName, imageRef);
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(80, 0, 0, 60, 20, 20),
      drawObject(imageName),
      popGraphicsState(),
    );
    const bytes = await pdf.save({ useObjectStreams: false });
    const pixels: DecodedImagePixels = {
      data: new Uint8ClampedArray(10 * 8 * 4).fill(255),
      width: 10,
      height: 8,
      originalBytes: imageStream.contents.length,
    };
    const maskData = new Uint8ClampedArray(5 * 4 * 4);
    const values = [0, 64, 128, 192, 255];
    for (let index = 0; index < 20; index += 1) {
      const value = values[index % 5]!;
      maskData.fill(value, index * 4, index * 4 + 3);
      maskData[index * 4 + 3] = 255;
    }
    const mask: DecodedImagePixels = {
      data: maskData, width: 5, height: 4, originalBytes: 20,
    };
    const result = await cropSourceImage(bytes, draw(), { x: 20, y: 20, w: 40, h: 60 }, {
      decode: async () => pixels,
      decodeMask: async () => mask,
      encodePng: pngEncoder,
      openReader: async () => fakeReader(),
    });
    expect(result?.slice(0, 8)).toEqual(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10));
    if (!result) throw new Error('Expected a transparent PNG crop.');
    const output = await decodedPixels(result);
    expect(output.width).toBe(5);
    expect(output.height).toBe(8);
    expect(output.data[3]).toBeLessThan(20);
    expect(output.data.at(-1)).toBeGreaterThan(40);
  }, 30_000);

  it('returns undefined for a tilted placement so the caller can render the exact fallback', async () => {
    const generated = await photoPdf();
    const tilted = {
      ...generated.imageDraw,
      placement: [300, 0.02, 0, -520, 20, 580],
    } as DrawnImage;
    const result = await cropSourceImage(
      generated.bytes,
      tilted,
      { x: 20, y: 20, w: 150, h: 520 },
      {
        decode: async () => generated.source,
        encodeJpeg: jpegEncoder,
        openReader: async () => fakeReader(),
      },
    );
    expect(result).toBeUndefined();
  }, 30_000);
});
