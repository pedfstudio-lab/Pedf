import { describe, expect, it } from 'vitest';
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readerAngleToRaw, readerFrame, readerToRaw } from './readerFrame';

describe('readerFrame', () => {
  const cases = [
    { rotation: 0, width: 160, height: 60, corners: [[10, 20], [170, 20], [10, 80], [170, 80]] },
    { rotation: 90, width: 60, height: 160, corners: [[170, 20], [170, 80], [10, 20], [10, 80]] },
    { rotation: 180, width: 160, height: 60, corners: [[170, 80], [10, 80], [170, 20], [10, 20]] },
    { rotation: 270, width: 60, height: 160, corners: [[10, 80], [10, 20], [170, 80], [170, 20]] },
  ] as const;

  it.each(cases)('maps all displayed corners at $rotation° with a non-zero CropBox', async ({ rotation, width, height, corners }) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 100]);
    page.setCropBox(10, 20, 160, 60);
    page.setRotation(degrees(rotation));
    const frame = readerFrame(page);
    expect(frame).toMatchObject({ x0: 10, y0: 20, W: 160, H: 60, rotation, width, height });
    const points = [readerToRaw(frame, 0, 0), readerToRaw(frame, width, 0),
      readerToRaw(frame, 0, height), readerToRaw(frame, width, height)];
    expect(points.map(({ x, y }) => [x, y])).toEqual(corners);
    expect(readerAngleToRaw(frame, 45)).toBe(45 + rotation);
  });

  it('normalizes an unusual page rotation before mapping it', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([100, 200]);
    page.setRotation(degrees(450));
    expect(readerFrame(page).rotation).toBe(90);
  });

  it.each([0, 90, 180, 270] as const)('draws reader-horizontal text at the displayed bottom centre on a %i° page', async (rotation) => {
    const source = await PDFDocument.create();
    const font = await source.embedFont(StandardFonts.Helvetica);
    const page = source.addPage([220, 140]);
    page.setCropBox(10, 20, 180, 100);
    page.setRotation(degrees(rotation));
    const frame = readerFrame(page);
    const raw = readerToRaw(frame, frame.width / 2, 20);
    page.drawText('X', { x: raw.x, y: raw.y, font, size: 12, rotate: degrees(readerAngleToRaw(frame, 0)) });

    const pdf = await getDocument({ data: (await source.save()).slice() }).promise;
    try {
      const rendered = await pdf.getPage(1);
      const viewport = rendered.getViewport({ scale: 1 });
      const text = await rendered.getTextContent();
      const item = text.items.find((candidate) => 'str' in candidate && candidate.str === 'X');
      expect(item && 'transform' in item).toBe(true);
      if (!item || !('transform' in item)) return;
      const [screenX, screenY] = viewport.convertToViewportPoint(item.transform[4]!, item.transform[5]!);
      expect(screenX).toBeCloseTo(frame.width / 2, 3);
      expect(screenY).toBeCloseTo(frame.height - 20, 3);
      const screenTransform = Util.transform(viewport.transform, item.transform);
      expect(screenTransform[0]).toBeGreaterThan(0);
      expect(screenTransform[1]).toBeCloseTo(0, 4);
    } finally { await pdf.destroy(); }
  });
});
