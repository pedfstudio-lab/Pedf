import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  PDFDocument,
  PDFRawStream,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';
import { detectImages } from '@/lib/pdf/images';
import { extractImageBytes } from './extractImage';

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
});
