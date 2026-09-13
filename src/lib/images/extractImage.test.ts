import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';
import { detectImages } from '@/lib/pdf/images';
import { extractImageBytes, extractImageBytesByRef, imageDrawsInContent } from './extractImage';

const BLACK_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

describe('extractImageBytes', () => {
  it('extracts a GOA DCT photo without changing its encoded pixel dimensions', async () => {
    const source = new Uint8Array(await readFile(
      new URL('../../../public/samples/GOA 2026.pdf', import.meta.url),
    ));
    const pdfJs = await getDocument({ data: source.slice(), verbosity: 0 }).promise;
    const pdfLib = await PDFDocument.load(source, { updateMetadata: false });
    try {
      const page = await pdfJs.getPage(8);
      const [region] = await detectImages(page, 7);
      expect(region).toBeTruthy();
      const extracted = extractImageBytes(pdfLib, 7, region!.rect);
      expect(extracted?.mime).toBe('image/jpeg');
      expect(extracted?.bytes.slice(0, 2)).toEqual(Uint8Array.of(0xff, 0xd8));
      const probe = await PDFDocument.create();
      const image = await probe.embedJpg(extracted!.bytes);
      expect({ width: image.width, height: image.height }).toEqual({ width: 386, height: 665 });
    } finally {
      await pdfJs.destroy();
    }
  });

  it('converts a generated Flate image and soft mask into a reusable PNG', async () => {
    const source = await PDFDocument.create({ updateMetadata: false });
    const page = source.addPage([200, 160]);
    const embedded = await source.embedPng(decodeBase64(BLACK_PIXEL_PNG_BASE64));
    page.drawImage(embedded, { x: 20, y: 30, width: 80, height: 60 });
    const reopened = await PDFDocument.load(await source.save(), { updateMetadata: false });

    const extracted = extractImageBytes(reopened, 0, { x: 20, y: 30, w: 80, h: 60 });
    expect(extracted?.mime).toBe('image/png');
    expect(extracted?.bytes.slice(0, 8)).toEqual(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10));
    const probe = await PDFDocument.create();
    const image = await probe.embedPng(extracted!.bytes);
    expect({ width: image.width, height: image.height }).toEqual({ width: 1, height: 1 });
  });

  it('returns undefined for an unsupported image filter', async () => {
    const source = await PDFDocument.create({ updateMetadata: false });
    const page = source.addPage([200, 160]);
    const stream = PDFRawStream.of(source.context.obj({
      Type: 'XObject',
      Subtype: 'Image',
      Width: 2,
      Height: 2,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      Filter: 'JPXDecode',
    }), Uint8Array.of(1, 2, 3, 4));
    const name = page.node.newXObject('Unsupported', source.context.register(stream));
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(40, 0, 0, 30, 10, 20),
      drawObject(name),
      popGraphicsState(),
    );
    const reopened = await PDFDocument.load(await source.save(), { updateMetadata: false });
    expect(extractImageBytes(reopened, 0, { x: 10, y: 20, w: 40, h: 30 })).toBeUndefined();
  });

  it('returns undefined without throwing for a Flate image with an ICCBased colour space', async () => {
    const source = await PDFDocument.create({ updateMetadata: false });
    const page = source.addPage([200, 160]);
    const profile = source.context.flateStream(new Uint8Array(), { N: 3 });
    const profileRef = source.context.register(profile);
    const stream = source.context.flateStream(new Uint8Array(12).fill(120), {
      Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2,
      ColorSpace: source.context.obj([PDFName.of('ICCBased'), profileRef]), BitsPerComponent: 8,
    });
    const name = page.node.newXObject('IccPhoto', source.context.register(stream));
    page.pushOperators(
      pushGraphicsState(), concatTransformationMatrix(40, 0, 0, 30, 10, 20),
      drawObject(name), popGraphicsState(),
    );
    const reopened = await PDFDocument.load(await source.save(), { updateMetadata: false });
    expect(() => extractImageBytes(reopened, 0, { x: 10, y: 20, w: 40, h: 30 })).not.toThrow();
    expect(extractImageBytes(reopened, 0, { x: 10, y: 20, w: 40, h: 30 })).toBeUndefined();
  });

  it('extracts the exact referenced image when rectangles cannot distinguish stacked draws', async () => {
    const source = await PDFDocument.create({ updateMetadata: false });
    source.addPage([100, 100]);
    const first = source.context.flateStream(new Uint8Array(12).fill(20), {
      Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2,
      ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    });
    const second = source.context.flateStream(new Uint8Array(12).fill(220), {
      Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2,
      ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    });
    const firstRef = source.context.register(first);
    const secondRef = source.context.register(second);
    const reopened = await PDFDocument.load(await source.save(), { updateMetadata: false });
    const firstBytes = extractImageBytesByRef(reopened, firstRef)?.bytes;
    const secondBytes = extractImageBytesByRef(reopened, secondRef)?.bytes;
    expect(firstBytes).toBeTruthy();
    expect(secondBytes).toBeTruthy();
    expect(firstBytes).not.toEqual(secondBytes);
  });
});

function rawImage(document: PDFDocument, value: number): [ReturnType<typeof document.context.register>, PDFRawStream] {
  const stream = PDFRawStream.of(document.context.obj({
    Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100,
    ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
  }), new Uint8Array(30_000).fill(value));
  return [document.context.register(stream), stream];
}

describe('imageDrawsInContent', () => {
  it('keeps two different image refs drawn at the same rectangle', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([200, 200]);
    const [firstRef] = rawImage(document, 70);
    const [secondRef] = rawImage(document, 90);
    const first = page.node.newXObject('First', firstRef);
    const second = page.node.newXObject('Second', secondRef);
    page.pushOperators(
      pushGraphicsState(), concatTransformationMatrix(120, 0, 0, 90, 20, 30), drawObject(first), popGraphicsState(),
      pushGraphicsState(), concatTransformationMatrix(120, 0, 0, 90, 20, 30), drawObject(second), popGraphicsState(),
    );
    const reopened = await PDFDocument.load(await document.save(), { updateMetadata: false });
    expect(imageDrawsInContent(reopened, 0)?.map((draw) => draw.ref?.toString()))
      .toEqual([firstRef.toString(), secondRef.toString()]);
  });

  it('includes the page transform and a Form Matrix in the image size', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([300, 300]);
    const [photoRef] = rawImage(document, 80);
    const form = PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Matrix: [2, 0, 0, 3, 0, 0],
      Resources: { XObject: { Photo: photoRef } },
    }), new TextEncoder().encode('/Photo Do'));
    const formName = page.node.newXObject('PhotoForm', document.context.register(form));
    page.pushOperators(
      pushGraphicsState(), concatTransformationMatrix(40, 0, 0, 50, 10, 20),
      drawObject(formName), popGraphicsState(),
    );
    const reopened = await PDFDocument.load(await document.save(), { updateMetadata: false });
    expect(imageDrawsInContent(reopened, 0)).toMatchObject([{
      ref: { objectNumber: photoRef.objectNumber, generationNumber: photoRef.generationNumber },
      widthPt: 80, heightPt: 150, rect: { x: 10, y: 20, w: 80, h: 150 },
    }]);
  });

  it('returns separate entries when one image is drawn twice at different sizes', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([300, 300]);
    const [photoRef] = rawImage(document, 80);
    const photo = page.node.newXObject('Photo', photoRef);
    page.pushOperators(
      pushGraphicsState(), concatTransformationMatrix(40, 0, 0, 30, 10, 20), drawObject(photo), popGraphicsState(),
      pushGraphicsState(), concatTransformationMatrix(120, 0, 0, 90, 50, 80), drawObject(photo), popGraphicsState(),
    );
    const reopened = await PDFDocument.load(await document.save(), { updateMetadata: false });
    expect(imageDrawsInContent(reopened, 0)?.map(({ widthPt, heightPt }) => ({ widthPt, heightPt })))
      .toEqual([{ widthPt: 40, heightPt: 30 }, { widthPt: 120, heightPt: 90 }]);
  });

  it('returns undefined when a page content stream cannot be decoded', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([200, 200]);
    const content = PDFRawStream.of(document.context.obj({ Filter: 'JPXDecode' }), Uint8Array.of(1, 2, 3));
    page.node.set(PDFName.of('Contents'), document.context.register(content));
    const reopened = await PDFDocument.load(await document.save(), { updateMetadata: false });
    expect(imageDrawsInContent(reopened, 0)).toBeUndefined();
  });
});
