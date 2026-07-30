import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import type { PageGeometry } from '@/lib/pdf/types';
import type { PdfRect } from './types';
import {
  closedFormViewportToPdf,
  pdfRectToScreenRect,
  pdfToScreen,
  screenRectToPdfRect,
  screenToPdf,
  screenToViewport,
  viewportToPdf,
} from './coordinates';
import type { PdfPt, ScreenPt, ScreenRect, ViewportPt } from './coordinates';

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const ROTATIONS = [0, 90, 180, 270] as const;
const EPSILON_DIGITS = 8;

let documentProxy: PDFDocumentProxy;
let page: PDFPageProxy;

beforeAll(async () => {
  const source = await PDFDocument.create();
  source.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const bytes = await source.save();

  documentProxy = await getDocument({ data: bytes.slice() }).promise;
  page = await documentProxy.getPage(1);
});

afterAll(async () => {
  await documentProxy.destroy();
});

function geometry(rotation: PageGeometry['rotation']): PageGeometry {
  return {
    pageIndex: 0,
    widthPt: PAGE_WIDTH,
    heightPt: PAGE_HEIGHT,
    rotation,
    boxOffset: { x: 0, y: 0 },
  };
}

function expectPointClose(actual: PdfPt | ScreenPt, expected: { x: number; y: number }): void {
  expect(actual.x).toBeCloseTo(expected.x, EPSILON_DIGITS);
  expect(actual.y).toBeCloseTo(expected.y, EPSILON_DIGITS);
}

function expectRectClose(
  actual: PdfRect | ScreenRect,
  expected: PdfRect | ScreenRect,
): void {
  const actualValues = Object.values(actual);
  const expectedValues = Object.values(expected);
  expect(actualValues).toHaveLength(expectedValues.length);
  actualValues.forEach((value, index) => {
    expect(value).toBeCloseTo(expectedValues[index] ?? Number.NaN, EPSILON_DIGITS);
  });
}

describe('coordinate transforms', () => {
  describe('known screen-to-PDF mappings', () => {
    const zoom = 1.5;
    const dpr = 2;
    const screenPoint: ScreenPt = { x: 120, y: 160 };

    const cases: ReadonlyArray<{
      rotation: PageGeometry['rotation'];
      expected: PdfPt;
    }> = [
      { rotation: 0, expected: { x: 80, y: PAGE_HEIGHT - 160 / zoom } },
      { rotation: 90, expected: { x: 160 / zoom, y: 80 } },
      { rotation: 180, expected: { x: PAGE_WIDTH - 80, y: 160 / zoom } },
      {
        rotation: 270,
        expected: { x: PAGE_WIDTH - 160 / zoom, y: PAGE_HEIGHT - 80 },
      },
    ];

    it.each(cases)('maps rotation $rotation using a hand-computed result', ({ rotation, expected }) => {
      const viewport = page.getViewport({ scale: zoom * dpr, rotation });
      expectPointClose(screenToPdf(viewport, screenPoint, dpr), expected);
    });
  });

  describe('closed form agrees with PDF.js', () => {
    it.each(ROTATIONS)('cross-checks rotation %i', (rotation) => {
      const renderScale = 2.75;
      const viewportPoint: ViewportPt = { x: 231.25, y: 417.5 };
      const viewport = page.getViewport({ scale: renderScale, rotation });

      const authoritative = viewportToPdf(viewport, viewportPoint);
      const fallback = closedFormViewportToPdf(
        viewportPoint,
        geometry(rotation),
        renderScale,
      );

      expectPointClose(fallback, authoritative);
    });
  });

  describe('round-trip identity', () => {
    it.each(ROTATIONS)('round-trips points and rectangles at rotation %i', (rotation) => {
      const zoom = 1.75;
      const dpr = 2.5;
      const viewport = page.getViewport({ scale: zoom * dpr, rotation });
      const pdfPoint: PdfPt = { x: 137.125, y: 624.75 };
      const pdfRect: PdfRect = { x: 91.5, y: 244.25, w: 188.75, h: 63.5 };

      const screenPoint = pdfToScreen(viewport, pdfPoint, dpr);
      expectPointClose(screenToPdf(viewport, screenPoint, dpr), pdfPoint);

      const screenRect = pdfRectToScreenRect(pdfRect, viewport, dpr);
      expectRectClose(screenRectToPdfRect(screenRect, viewport, dpr), pdfRect);
    });
  });

  describe('device-pixel-ratio invariance', () => {
    it.each(ROTATIONS)('cancels DPR at rotation %i', (rotation) => {
      const zoom = 1.4;
      const screenRect: ScreenRect = { left: 52, top: 73, width: 196, height: 84 };
      const atDprOne = screenRectToPdfRect(
        screenRect,
        page.getViewport({ scale: zoom, rotation }),
        1,
      );
      const pointAtDprOne = screenToPdf(
        page.getViewport({ scale: zoom, rotation }),
        { x: screenRect.left, y: screenRect.top },
        1,
      );

      for (const dpr of [2, 3]) {
        const viewport = page.getViewport({ scale: zoom * dpr, rotation });
        expectRectClose(screenRectToPdfRect(screenRect, viewport, dpr), atDprOne);

        const viewportPoint = screenToViewport({ x: screenRect.left, y: screenRect.top }, dpr);
        expectPointClose(viewportToPdf(viewport, viewportPoint), pointAtDprOne);
      }
    });
  });
});
