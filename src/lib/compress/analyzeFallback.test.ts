// @vitest-environment jsdom
import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  PDFRawStream,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/pdf/worker', async () => ({ pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs') }));
vi.mock('@/lib/images/extractImage', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/images/extractImage')>();
  return { ...original, imageDrawsInContent: () => undefined };
});

import { analyzePdf } from './analyze';

describe('PDF photo analysis content-name fallback', () => {
  it('uses the pdf.js rectangle path and marks names incomplete when content cannot be decoded', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([200, 200]);
    const stream = PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 400, Height: 400,
      ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    }), new Uint8Array(400 * 400 * 3).fill(80));
    const ref = document.context.register(stream);
    const name = page.node.newXObject('Photo', ref);
    page.pushOperators(
      pushGraphicsState(), concatTransformationMatrix(160, 0, 0, 120, 20, 30),
      drawObject(name), popGraphicsState(),
    );
    const result = await analyzePdf(await document.save(), new AbortController().signal);
    const photo = result.images.find((image) => image.ref?.objectNumber === ref.objectNumber);
    expect(photo).toMatchObject({ drawnWidthPt: 160, drawnHeightPt: 120 });
    expect(photo?.skipReason).not.toBe('never drawn');
    expect(result.namesIncomplete).toBe(true);
    expect(result.images.some((image) => image.skipReason === 'cannot be matched to a ref')).toBe(false);
  });
});
