// @vitest-environment jsdom
import {
  concatTransformationMatrix,
  drawObject,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  popGraphicsState,
  pushGraphicsState,
  StandardFonts,
} from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { deduplicateImages, replaceImage } from './replace';

function imageObjects(document: PDFDocument): Array<[PDFRef, PDFRawStream]> {
  return document.context.enumerateIndirectObjects().filter((entry): entry is [PDFRef, PDFRawStream] => {
    const object = entry[1];
    return object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image');
  });
}

describe('in-place PDF image replacement', () => {
  it('keeps page text plus SMask and optional-content references', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([300, 300]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText('Selectable text remains', { x: 20, y: 260, font, size: 12 });
    const mask = PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100,
      ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    }), new Uint8Array(10_000).fill(255));
    const maskRef = document.context.register(mask);
    const layerRef = document.context.register(document.context.obj({ Type: 'OCG', Name: 'Photo layer' }));
    const photo = PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100,
      ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: maskRef, OC: layerRef,
    }), new Uint8Array(30_000));
    const photoRef = document.context.register(photo);
    const name = page.node.newXObject('Photo', photoRef);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(100, 0, 0, 100, 20, 100), drawObject(name), popGraphicsState());

    replaceImage(document, { objectNumber: photoRef.objectNumber, generationNumber: photoRef.generationNumber },
      Uint8Array.of(0xff, 0xd8, 0xff, 0xd9), { width: 60, height: 60 }, new Uint8Array(3_600).fill(255));
    const replaced = document.context.lookup(photoRef);
    expect(replaced).toBeInstanceOf(PDFRawStream);
    if (!(replaced instanceof PDFRawStream)) throw new Error('replacement missing');
    expect(replaced.dict.get(PDFName.of('SMask'))).toBe(maskRef);
    expect(replaced.dict.get(PDFName.of('OC'))).toBe(layerRef);
    expect(replaced.dict.get(PDFName.of('Metadata'))).toBeUndefined();
    expect(replaced.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(60);
    const resizedMask = document.context.lookup(maskRef);
    expect(resizedMask).toBeInstanceOf(PDFRawStream);
    if (!(resizedMask instanceof PDFRawStream)) throw new Error('resized mask missing');
    expect(resizedMask.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(60);
    expect(resizedMask.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber()).toBe(60);

    const bytes = await document.save();
    const reader = await getDocument({ data: bytes.slice() }).promise;
    try {
      const text = await (await reader.getPage(1)).getTextContent();
      expect(text.items.map((item) => 'str' in item ? item.str : '').join(' ')).toContain('Selectable text remains');
      expect(reader.numPages).toBe(1);
    } finally { await reader.destroy(); }
  });

  it('keeps a smaller original mask shared when resizing one of its photos', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([200, 200]);
    const maskRef = document.context.register(PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100,
      ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'DCTDecode',
    }), new Uint8Array(100).fill(200)));
    const makePhoto = () => document.context.register(PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100,
      ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: maskRef,
    }), new Uint8Array(30_000)));
    const first = makePhoto();
    const second = makePhoto();
    page.node.newXObject('First', first);
    page.node.newXObject('Second', second);
    let randomState = 0x9e3779b9;
    const resizedPixels = Uint8Array.from({ length: 2_500 }, () => {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      return randomState & 0xff;
    });

    replaceImage(document, { objectNumber: first.objectNumber, generationNumber: first.generationNumber },
      Uint8Array.of(0xff, 0xd8, 0xff, 0xd9), { width: 50, height: 50 }, resizedPixels);

    const replaced = document.context.lookup(first);
    const untouched = document.context.lookup(second);
    expect(replaced).toBeInstanceOf(PDFRawStream);
    expect(untouched).toBeInstanceOf(PDFRawStream);
    if (!(replaced instanceof PDFRawStream) || !(untouched instanceof PDFRawStream)) {
      throw new Error('photo streams missing');
    }
    const replacementMask = replaced.dict.get(PDFName.of('SMask'));
    expect(replacementMask).toBe(maskRef);
    expect(untouched.dict.get(PDFName.of('SMask'))).toBe(maskRef);
    const originalMask = document.context.lookup(maskRef);
    if (!(originalMask instanceof PDFRawStream)) throw new Error('original mask missing');
    expect(originalMask.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(100);
    expect(originalMask.contents).toHaveLength(100);
  });

  it('repoints identical resource images and saves only one object', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([200, 200]);
    const dictionary = () => document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 80, Height: 80, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    }) as PDFDict;
    const bytes = new Uint8Array(80 * 80 * 3).fill(120);
    const first = document.context.register(PDFRawStream.of(dictionary(), bytes));
    const second = document.context.register(PDFRawStream.of(dictionary(), bytes.slice()));
    page.node.newXObject('First', first);
    page.node.newXObject('Second', second);

    expect(await deduplicateImages(document)).toBe(1);
    const reopened = await PDFDocument.load(await document.save(), { updateMetadata: false });
    expect(imageObjects(reopened)).toHaveLength(1);
    const xObjects = reopened.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    expect(new Set(xObjects.keys().map((key) => xObjects.get(key)?.toString())).size).toBe(1);
  });

  it('keeps a small JPEG mask and replaces only the photo when the resized mask would be larger', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const documentPage = document.addPage([200, 200]);
    const maskRef = document.context.register(PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100,
      ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'DCTDecode',
    }), new Uint8Array(100).fill(7)));
    const original = new Uint8Array(30_000).fill(80);
    const photoRef = document.context.register(PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100,
      ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: maskRef,
    }), original));
    documentPage.node.newXObject('Photo', photoRef);
    let randomState = 0x12345678;
    const noisyMask = Uint8Array.from({ length: 10_000 }, () => {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      return randomState & 0xff;
    });

    expect(replaceImage(document,
      { objectNumber: photoRef.objectNumber, generationNumber: photoRef.generationNumber },
      new Uint8Array(20_000).fill(5), { width: 50, height: 50 }, noisyMask.subarray(0, 2_500))).toBe(true);
    const replaced = document.context.lookup(photoRef);
    expect(replaced).toBeInstanceOf(PDFRawStream);
    if (!(replaced instanceof PDFRawStream)) throw new Error('photo missing');
    expect(replaced.contents).toEqual(new Uint8Array(20_000).fill(5));
    expect(replaced.dict.get(PDFName.of('SMask'))).toBe(maskRef);
    const untouchedMask = document.context.lookup(maskRef);
    expect(untouchedMask).toBeInstanceOf(PDFRawStream);
    if (!(untouchedMask instanceof PDFRawStream)) throw new Error('mask missing');
    expect(untouchedMask.contents).toHaveLength(100);
    expect(untouchedMask.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(100);
  });
});
