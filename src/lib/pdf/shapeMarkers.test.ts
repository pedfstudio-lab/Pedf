import { describe, expect, it, vi } from 'vitest';
import {
  appendBezierCurve,
  clip,
  drawObject,
  endPath,
  fill,
  moveTo,
  PDFDocument,
  rectangle,
  rgb,
} from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { detectPageGraphicRegions, detectShapeMarkers } from './shapeMarkers';

const KAPPA = 4 * ((Math.sqrt(2) - 1) / 3);

function circlePath(centerX: number, centerY: number, radius: number) {
  const left = centerX - radius;
  const right = centerX + radius;
  const bottom = centerY - radius;
  const top = centerY + radius;
  const offset = radius * KAPPA;
  return [
    moveTo(left, centerY),
    appendBezierCurve(left, centerY - offset, centerX - offset, bottom, centerX, bottom),
    appendBezierCurve(centerX + offset, bottom, right, centerY - offset, right, centerY),
    appendBezierCurve(right, centerY + offset, centerX + offset, top, centerX, top),
    appendBezierCurve(centerX - offset, top, left, centerY + offset, left, centerY),
  ];
}

async function generatedShapePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([300, 300]);
  for (const y of [250, 220, 190]) {
    page.drawCircle({ x: 20, y, size: 2, color: rgb(0, 0, 0) });
  }
  page.drawCircle({
    x: 50,
    y: 250,
    size: 2,
    borderColor: rgb(0, 0, 0),
    borderWidth: 1,
  });
  page.drawRectangle({ x: 70, y: 230, width: 20, height: 20, color: rgb(0, 0, 0) });
  page.pushOperators(rectangle(100, 230, 4, 4), clip(), endPath());

  const form = document.context.formXObject(
    [...circlePath(2, 2, 2), fill()],
    {
      BBox: [0, 0, 4, 4],
      Matrix: [1, 0, 0, 1, 120, 160],
      Resources: {},
    },
  );
  const formName = page.node.newXObject('ShapeMarker', document.context.register(form));
  page.pushOperators(drawObject(formName));
  return document.save({ useObjectStreams: false });
}

describe('detectShapeMarkers', () => {
  it('finds small filled circles while rejecting stroke-only, large, and clipping paths', async () => {
    const bytes = await generatedShapePdf();
    const document = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    try {
      const regions = await detectShapeMarkers(await document.getPage(1), 0);
      expect(regions).toHaveLength(4);
      expect(regions.slice(0, 3).map(({ rect }) => ({
        x: Number(rect.x.toFixed(2)),
        y: Number(rect.y.toFixed(2)),
        w: Number(rect.w.toFixed(2)),
        h: Number(rect.h.toFixed(2)),
      }))).toEqual([
        { x: 18, y: 248, w: 4, h: 4 },
        { x: 18, y: 218, w: 4, h: 4 },
        { x: 18, y: 188, w: 4, h: 4 },
      ]);
    } finally {
      await document.destroy();
    }
  });

  it('applies a Form XObject Matrix to a small filled circle', async () => {
    const bytes = await generatedShapePdf();
    const document = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    try {
      const regions = await detectShapeMarkers(await document.getPage(1), 3);
      expect(regions.at(-1)).toEqual({
        pageIndex: 3,
        rect: { x: 120, y: 160, w: 4, h: 4 },
      });
    } finally {
      await document.destroy();
    }
  });

  it('shares one operator-list fetch with image detection', async () => {
    const bytes = await generatedShapePdf();
    const document = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    try {
      const page = await document.getPage(1);
      const getOperatorList = vi.spyOn(page, 'getOperatorList');
      const regions = await detectPageGraphicRegions(page, 0);

      expect(getOperatorList).toHaveBeenCalledTimes(1);
      expect(regions.imageRegions).toEqual([]);
      expect(regions.shapeMarkerRegions).toHaveLength(4);
    } finally {
      await document.destroy();
    }
  });
});
