import { describe, expect, it } from 'vitest';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import type { EditDocument, PdfRect } from './types';
import { imageRegionsFromOperatorList } from '@/lib/pdf/images';
import { exportPdf } from './exportPdf';

const BLACK_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function pngBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(BLACK_PIXEL_PNG_BASE64, 'base64'));
}

describe('moved image export', () => {
  it('covers the old draw before placing the same image at its new rectangle', async () => {
    const oldRect: PdfRect = { x: 20, y: 30, w: 80, h: 40 };
    const newRect: PdfRect = { x: 110, y: 120, w: 60, h: 30 };
    const source = await PDFDocument.create({ updateMetadata: false });
    const page = source.addPage([200, 200]);
    const embedded = await source.embedPng(pngBytes());
    page.drawImage(embedded, {
      x: oldRect.x,
      y: oldRect.y,
      width: oldRect.w,
      height: oldRect.h,
    });
    const doc: EditDocument = {
      originalBytes: await source.save(),
      pages: [{
        pageIndex: 0,
        widthPt: 200,
        heightPt: 200,
        rotation: 0,
        boxOffset: { x: 0, y: 0 },
      }],
      edits: [
        {
          id: 'image-move-cover-test',
          kind: 'cover',
          pageIndex: 0,
          rect: oldRect,
          z: 1,
          color: { r: 1, g: 1, b: 1 },
          sampleBackground: false,
        },
        {
          id: 'image-moved-test',
          kind: 'image',
          pageIndex: 0,
          rect: newRect,
          z: 2,
          bytes: pngBytes(),
        },
      ],
    };
    const output = await exportPdf(doc);
    const reopened = await getDocument({ data: output.bytes.slice(), verbosity: 0 }).promise;
    try {
      const outputPage = await reopened.getPage(1);
      const operators = await outputPage.getOperatorList();
      const imageIndices = operators.fnArray
        .map((operator, index) => operator === OPS.paintImageXObject ? index : -1)
        .filter((index) => index >= 0);
      expect(imageIndices).toHaveLength(2);
      const coverTransformIndex = operators.fnArray.findIndex((operator, index) =>
        operator === OPS.transform &&
        index > imageIndices[0]! &&
        index < imageIndices[1]! &&
        JSON.stringify(operators.argsArray[index]) === JSON.stringify([1, 0, 0, 1, oldRect.x, oldRect.y]),
      );
      expect(coverTransformIndex).toBeGreaterThan(imageIndices[0]!);
      expect(operators.fnArray.slice(coverTransformIndex, imageIndices[1])).toContain(OPS.fill);
      const regions = imageRegionsFromOperatorList(
        operators,
        outputPage.getViewport({ scale: 1 }),
        0,
      );
      expect(regions.map((region) => region.rect)).toEqual(expect.arrayContaining([oldRect, newRect]));
    } finally {
      await reopened.destroy();
    }
  });
});
