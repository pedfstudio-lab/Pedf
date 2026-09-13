// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  PDFRawStream,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { analyzePdf, trailingByteCount } from './analyze';

vi.mock('@/lib/pdf/worker', async () => ({ pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs') }));

function pixels(width: number, height: number, channels: number): Uint8Array {
  return Uint8Array.from({ length: width * height * channels }, (_, index) => index % 251);
}

describe('PDF photo analysis', () => {
  it('finds the large GOA photos and their effective drawn dpi', async () => {
    const bytes = new Uint8Array(readFileSync(resolve('public/samples/GOA 2026.pdf')));
    const result = await analyzePdf(bytes, new AbortController().signal);
    expect(result.fileSize).toBe(bytes.byteLength);
    expect(result.photoCount).toBeGreaterThan(0);
    expect(result.bytesInShrinkableImages).toBeGreaterThan(100_000);
    expect(result.trailingBytes).toBe(0);
    expect(result.namesIncomplete).toBe(false);
    expect(result.images.some((image) => image.shrinkable && (image.effectiveDpi ?? 0) >= 140)).toBe(true);
  }, 20_000);

  it('keeps the largest draw and explains every unsafe image it skips', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([400, 400]);
    const add = (name: string, width: number, height: number, extra: Record<string, unknown> = {}, draw = false) => {
      const channels = extra.ColorSpace === 'DeviceCMYK' ? 4 : 3;
      const stream = document.context.flateStream(pixels(width, height, channels), {
        Type: 'XObject', Subtype: 'Image', Width: width, Height: height,
        ColorSpace: 'DeviceRGB', BitsPerComponent: 8, ...extra,
      });
      const object = page.node.newXObject(name, document.context.register(stream));
      if (draw) page.pushOperators(
        pushGraphicsState(), concatTransformationMatrix(72, 0, 0, 48, 20, 20), drawObject(object), popGraphicsState(),
        pushGraphicsState(), concatTransformationMatrix(144, 0, 0, 96, 40, 120), drawObject(object), popGraphicsState(),
      );
      return stream;
    };

    add('Photo', 600, 400, {}, true);
    add('Tiny', 40, 40);
    add('OneBit', 100, 100, { BitsPerComponent: 1 });
    add('Cmyk', 100, 100, { ColorSpace: 'DeviceCMYK' });
    add('Masked', 100, 100, { Mask: [0, 0, 0, 0, 0, 0] });
    add('Undrawn', 100, 100);
    add('ImageMask', 100, 100, { ImageMask: true, ColorSpace: undefined, BitsPerComponent: 1 });
    const softMask = add('SoftMaskResource', 100, 100, { ColorSpace: 'DeviceGray' });
    const softMaskRef = document.context.getObjectRef(softMask)!;
    add('HasSoftMask', 100, 100, { SMask: softMaskRef });

    const result = await analyzePdf(await document.save(), new AbortController().signal);
    const photo = result.images.find((image) => image.shrinkable)!;
    expect(photo).toMatchObject({ width: 600, height: 400, drawnWidthPt: 144, drawnHeightPt: 96 });
    expect(result.images.find((image) => image.hasSoftMask)?.softMaskBytes).toBe(softMask.contents.length);
    expect(result.images.map((image) => image.skipReason)).toEqual(expect.arrayContaining([
      'under 64 px', '1-bit image', 'unsupported colour space', 'has a colour-key or stencil mask',
      'never drawn', 'image mask', 'used as a mask',
    ]));
    expect(result.unusedPhotoCount).toBeGreaterThan(0);
    expect(result.unusedPhotoBytes).toBeGreaterThan(0);
  });

  it('reports long trailing padding and byte-identical image copies', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([200, 200]);
    const image = () => PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100,
      ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    }), new Uint8Array(30_000).fill(120));
    page.node.newXObject('UnusedOne', document.context.register(image()));
    page.node.newXObject('UnusedTwo', document.context.register(image()));
    const saved = await document.save({ useObjectStreams: true });
    const bytes = new Uint8Array(saved.byteLength + 1_000_000);
    bytes.set(saved);
    const result = await analyzePdf(bytes, new AbortController().signal);
    expect(result.trailingBytes).toBe(1_000_000);
    expect(result.unusedPhotoCount).toBe(2);
    expect(result.duplicateCount).toBe(1);
    expect(result.duplicateBytes).toBe(30_000);
    expect(trailingByteCount(saved)).toBe(0);
  });

  it('credits two stacked full-page images to their own refs', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([300, 200]);
    const add = (name: string, value: number) => {
      const stream = PDFRawStream.of(document.context.obj({
        Type: 'XObject', Subtype: 'Image', Width: 600, Height: 400,
        ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
      }), new Uint8Array(600 * 400 * 3).fill(value));
      const ref = document.context.register(stream);
      const resource = page.node.newXObject(name, ref);
      page.pushOperators(
        pushGraphicsState(), concatTransformationMatrix(300, 0, 0, 200, 0, 0),
        drawObject(resource), popGraphicsState(),
      );
      return ref.toString();
    };
    const refs = [add('Background', 70), add('Foreground', 100)];
    const result = await analyzePdf(await document.save(), new AbortController().signal);
    const stacked = result.images.filter((image) => refs.includes(`${image.ref?.objectNumber} ${image.ref?.generationNumber} R`));
    expect(stacked).toHaveLength(2);
    expect(stacked.every((image) => image.drawnWidthPt === 300 && image.drawnHeightPt === 200)).toBe(true);
    expect(stacked.every((image) => image.skipReason !== 'never drawn')).toBe(true);
    expect(result.namesIncomplete).toBe(false);
  });

  it('does not count duplicate soft masks that the XObject deduper cannot merge', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([300, 200]);
    for (let index = 0; index < 2; index += 1) {
      const mask = PDFRawStream.of(document.context.obj({
        Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100,
        ColorSpace: 'DeviceGray', BitsPerComponent: 8,
      }), new Uint8Array(10_000).fill(255));
      const maskRef = document.context.register(mask);
      const photo = PDFRawStream.of(document.context.obj({
        Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100,
        ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: maskRef,
      }), new Uint8Array(30_000).fill(70 + index));
      const name = page.node.newXObject(`Photo${index}`, document.context.register(photo));
      page.pushOperators(
        pushGraphicsState(), concatTransformationMatrix(100, 0, 0, 100, index * 120, 20),
        drawObject(name), popGraphicsState(),
      );
    }
    const result = await analyzePdf(await document.save(), new AbortController().signal);
    expect(result.images.filter((image) => image.skipReason === 'used as a mask')).toHaveLength(2);
    expect(result.duplicateCount).toBe(0);
    expect(result.duplicateBytes).toBe(0);
  });

  it('marks an image listed in resources but absent from drawing instructions as never drawn', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([200, 200]);
    const stream = PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100,
      ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    }), new Uint8Array(30_000).fill(80));
    page.node.newXObject('Unused', document.context.register(stream));
    const result = await analyzePdf(await document.save(), new AbortController().signal);
    expect(result.images.find((image) => image.streamBytes === 30_000)?.skipReason).toBe('never drawn');
  });

  it('stops before opening when already aborted', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(analyzePdf(new Uint8Array(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
