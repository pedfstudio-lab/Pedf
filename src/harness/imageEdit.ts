import { PDFDocument } from 'pdf-lib';
import type { ImageEdit } from '@/lib/export/types';
import type { Scenario } from './runScenario';

const BLACK_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export const imageEditScenario: Scenario = {
  name: 'Lossless PNG image edit',
  tolerance: 0.001,
  async setup() {
    const width = 240;
    const height = 180;
    const rect = { x: 50, y: 55, w: 120, h: 70 };
    const bytes = decodeBase64(BLACK_PIXEL_PNG_BASE64);
    const source = await PDFDocument.create({ updateMetadata: false });
    source.addPage([width, height]);
    const originalBytes = await source.save();

    const expected = await PDFDocument.load(originalBytes, { updateMetadata: false });
    const embedded = await expected.embedPng(bytes);
    expected.getPage(0).drawImage(embedded, {
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
    });

    const edit: ImageEdit = {
      id: 'harness-image',
      kind: 'image',
      pageIndex: 0,
      rect,
      z: 1,
      bytes,
    };

    return {
      doc: {
        originalBytes,
        edits: [edit],
        pages: [{
          pageIndex: 0,
          widthPt: width,
          heightPt: height,
          rotation: 0,
          boxOffset: { x: 0, y: 0 },
        }],
      },
      expectedBytes: await expected.save(),
    };
  },
};
