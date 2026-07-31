import { afterEach, describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { TextRun } from './textContent';
import {
  classifyFontStyle,
  extractTextRuns,
  hitTestRun,
} from './textContent';

const openDocuments: PDFDocumentProxy[] = [];

afterEach(async () => {
  await Promise.all(openDocuments.splice(0).map((document) => document.destroy()));
});

describe('classifyFontStyle', () => {
  it.each([
    ['Helvetica', false, false],
    ['Arial-BoldMT', true, false],
    ['Times-Italic', false, true],
    ['Helvetica-BoldOblique', true, true],
    ['SourceSansPro-Semibold', true, false],
    ['Inter-700', true, false],
  ])('classifies %s', (fontName, bold, italic) => {
    expect(classifyFontStyle(fontName)).toEqual({ bold, italic });
  });
});

describe('extractTextRuns', () => {
  it('extracts text, PDF-point geometry, and style from a synthetic PDF', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([612, 792]);
    const font = await source.embedFont(StandardFonts.Helvetica);
    const text = 'Hello';
    const x = 100;
    const y = 700;
    const size = 24;
    const expectedWidth = font.widthOfTextAtSize(text, size);

    page.drawText(text, { x, y, size, font });

    const document = await getDocument({
      data: (await source.save()).slice(),
      verbosity: 0,
    }).promise;
    openDocuments.push(document);
    const runs = await extractTextRuns(await document.getPage(1), 3);

    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run?.pageIndex).toBe(3);
    expect(run?.text).toBe(text);
    expect(run?.rect.x).toBeCloseTo(x, 5);
    expect(run?.rect.y).toBeCloseTo(y, 5);
    expect(run?.rect.w).toBeCloseTo(expectedWidth, 5);
    expect(run?.rect.h).toBeCloseTo(size, 5);
    expect(run?.style.fontSizePt).toBeCloseTo(size, 5);
    expect(run?.style.bold).toBe(false);
    expect(run?.style.italic).toBe(false);
    expect(run?.style.color).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe('hitTestRun', () => {
  const large: TextRun = {
    pageIndex: 0,
    text: 'large',
    rect: { x: 10, y: 20, w: 100, h: 40 },
    style: {
      fontName: 'Helvetica',
      fontSizePt: 12,
      bold: false,
      italic: false,
      color: { r: 0, g: 0, b: 0 },
    },
  };
  const small: TextRun = {
    ...large,
    text: 'small',
    rect: { x: 30, y: 30, w: 20, h: 10 },
  };

  it('returns the smallest run containing the tap', () => {
    expect(hitTestRun([large, small], { x: 35, y: 35 })).toBe(small);
  });

  it('returns undefined outside every run', () => {
    expect(hitTestRun([large, small], { x: 200, y: 200 })).toBeUndefined();
  });

  it('prefers the later run when equal-area runs overlap', () => {
    const topmost = { ...small, text: 'topmost' };
    expect(hitTestRun([small, topmost], { x: 35, y: 35 })).toBe(topmost);
  });
});
