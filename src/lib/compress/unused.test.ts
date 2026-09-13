// @vitest-environment jsdom
import {
  concatTransformationMatrix,
  drawObject,
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  popGraphicsState,
  pushGraphicsState,
  StandardFonts,
} from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { xObjectNamesInContent } from '@/lib/images/extractImage';
import type { CompressAnalysis, CompressImageAnalysis } from './analyze';
import { removeUnusedImages } from './unused';

function image(document: PDFDocument, value = 80): [PDFRef, PDFRawStream] {
  const stream = PDFRawStream.of(document.context.obj({
    Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100,
    ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
  }), new Uint8Array(30_000).fill(value));
  return [document.context.register(stream), stream];
}

function unusedAnalysis(ref: PDFRef, stream: PDFRawStream): CompressAnalysis {
  const entry: CompressImageAnalysis = {
    id: ref.toString(), ref: { objectNumber: ref.objectNumber, generationNumber: ref.generationNumber },
    width: 100, height: 100, filters: [], colorSpace: 'DeviceRGB', bitsPerComponent: 8,
    imageMask: false, hasSoftMask: false, hasMask: false, streamBytes: stream.contents.length,
    drawnWidthPt: 0, drawnHeightPt: 0, shrinkable: false, skipReason: 'never drawn',
  };
  return {
    fileSize: 31_000, bytesInShrinkableImages: 0, photoCount: 0, skippedCount: 1,
    trailingBytes: 0, unusedPhotoBytes: stream.contents.length, unusedPhotoCount: 1,
    duplicateBytes: 0, duplicateCount: 0, namesIncomplete: false, signed: false, images: [entry],
  };
}

function hasRef(document: PDFDocument, ref: PDFRef): boolean {
  return document.context.enumerateIndirectObjects().some(([candidate]) => candidate.toString() === ref.toString());
}

describe('lossless unused image removal', () => {
  it('removes an undrawn page resource while preserving page count and text', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([300, 300]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText('Text remains selectable', { x: 20, y: 260, font, size: 12 });
    const [ref, stream] = image(document);
    page.node.newXObject('Unused', ref);
    expect(removeUnusedImages(document, unusedAnalysis(ref, stream))).toEqual({ removed: 1, bytes: 30_000 });
    expect(hasRef(document, ref)).toBe(false);

    const bytes = await document.save({ useObjectStreams: true });
    const reader = await getDocument({ data: bytes.slice() }).promise;
    try {
      expect(reader.numPages).toBe(1);
      const text = await (await reader.getPage(1)).getTextContent();
      expect(text.items.map((item) => 'str' in item ? item.str : '').join(' ')).toContain('Text remains selectable');
      await (await reader.getPage(1)).getOperatorList();
    } finally { await reader.destroy(); }
  });

  it('keeps an image whose name is drawn on another page', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const unusedPage = document.addPage([200, 200]);
    const drawnPage = document.addPage([200, 200]);
    const [ref, stream] = image(document);
    unusedPage.node.newXObject('Photo', ref);
    const drawnName = drawnPage.node.newXObject('Photo', ref);
    drawnPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(100, 0, 0, 100, 20, 20),
      drawObject(drawnName), popGraphicsState());
    const contents = drawnPage.node.Contents();
    const drawnStreams = contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, index) => contents.lookup(index, PDFStream))
      : [contents!];
    expect(drawnStreams.flatMap((entry) => xObjectNamesInContent(entry) ?? [])).toContain(drawnName.decodeText());
    expect(removeUnusedImages(document, unusedAnalysis(ref, stream))).toEqual({ removed: 0, bytes: 0 });
    expect(hasRef(document, ref)).toBe(true);
  });

  it('keeps an image named by a Form XObject that inherits page resources', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([200, 200]);
    const [ref, stream] = image(document);
    const photoName = page.node.newXObject('Photo', ref);
    const form = PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100],
    }), new TextEncoder().encode(`/${photoName.decodeText()} Do`));
    page.node.newXObject('UnusedForm', document.context.register(form));
    expect(removeUnusedImages(document, unusedAnalysis(ref, stream))).toEqual({ removed: 0, bytes: 0 });
    expect(hasRef(document, ref)).toBe(true);
  });

  it('keeps an image used as a soft mask even if the supplied analysis calls it undrawn', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([200, 200]);
    const [maskRef, mask] = image(document, 255);
    page.node.newXObject('MaskResource', maskRef);
    const photo = PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 100, Height: 100,
      ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: maskRef,
    }), new Uint8Array(30_000).fill(90));
    page.node.newXObject('Photo', document.context.register(photo));
    expect(removeUnusedImages(document, unusedAnalysis(maskRef, mask))).toEqual({ removed: 0, bytes: 0 });
    expect(hasRef(document, maskRef)).toBe(true);
    expect(document.context.lookup(maskRef)).toBeInstanceOf(PDFRawStream);
    expect((document.context.lookup(maskRef) as PDFRawStream).dict.get(PDFName.of('Subtype'))).toBe(PDFName.of('Image'));
  });

  it('keeps an image reachable from an annotation appearance', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([200, 200]);
    const [ref, stream] = image(document);
    page.node.newXObject('UnusedOnPage', ref);
    const appearance = PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100],
      Resources: { XObject: { Photo: ref } },
    }), new TextEncoder().encode('/Photo Do'));
    const appearanceRef = document.context.register(appearance);
    const annotationRef = document.context.register(document.context.obj({
      Type: 'Annot', Subtype: 'Stamp', Rect: [20, 20, 120, 120], AP: { N: appearanceRef },
    }));
    page.node.set(PDFName.of('Annots'), document.context.obj([annotationRef]));

    expect(removeUnusedImages(document, unusedAnalysis(ref, stream))).toEqual({ removed: 0, bytes: 0 });
    expect(hasRef(document, ref)).toBe(true);
  });

  it('keeps an image referenced from a pattern resource elsewhere in the file', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([200, 200]);
    const [ref, stream] = image(document);
    page.node.newXObject('UnusedOnPage', ref);
    document.context.register(PDFRawStream.of(document.context.obj({
      Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1,
      BBox: [0, 0, 10, 10], XStep: 10, YStep: 10,
      Resources: { XObject: { PatternPhoto: ref } },
    }), new Uint8Array()));

    expect(removeUnusedImages(document, unusedAnalysis(ref, stream))).toEqual({ removed: 0, bytes: 0 });
    expect(hasRef(document, ref)).toBe(true);
  });

  it('removes nothing when the analysis could not finish the name walk', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([200, 200]);
    const [ref, stream] = image(document);
    page.node.newXObject('Unused', ref);
    const analysis = { ...unusedAnalysis(ref, stream), namesIncomplete: true };

    expect(removeUnusedImages(document, analysis)).toEqual({ removed: 0, bytes: 0 });
    expect(hasRef(document, ref)).toBe(true);
  });
});
