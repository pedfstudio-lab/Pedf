import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { extractTextRuns } from '@/lib/pdf/textContent';
import type { PageExportContext } from './context';
import {
  drawTextWithPageFont,
  registerPdfJsFontReference,
  resolvePageFontResource,
} from './embeddedFont';

const openDocuments: PDFDocumentProxy[] = [];

afterEach(async () => {
  await Promise.all(openDocuments.splice(0).map((document) => document.destroy()));
});

function makeContext(pdf: PDFDocument): PageExportContext {
  return {
    pdf,
    page: pdf.getPage(0),
    geometry: {
      pageIndex: 0,
      widthPt: pdf.getPage(0).getWidth(),
      heightPt: pdf.getPage(0).getHeight(),
      rotation: 0,
      boxOffset: { x: 0, y: 0 },
    },
    warnings: [],
    drawRect: () => undefined,
    sampleBackground: () => undefined,
  };
}

describe('page-owned embedded fonts', () => {
  it('matches the résumé font by BaseFont and writes selectable text through /F2', async () => {
    const originalBytes = new Uint8Array(
      await readFile('public/samples/RAHUL RAJPUT RESUME.pdf'),
    );
    const browserDocument = await getDocument({ data: originalBytes.slice(), verbosity: 0 }).promise;
    openDocuments.push(browserDocument);
    const runs = await extractTextRuns(await browserDocument.getPage(1), 0);

    const pdf = await PDFDocument.load(originalBytes, { updateMetadata: false });
    const context = makeContext(pdf);
    const sourceRun = runs.find((run) => (
      resolvePageFontResource(context, run.style)?.name.decodeText() === 'F2'
    ));
    expect(sourceRun?.style.fontRef).toBeTruthy();
    expect(resolvePageFontResource(context, sourceRun!.style)?.name.decodeText()).toBe('F2');

    const probe = 'Embedded font probe';
    expect(drawTextWithPageFont(
      probe,
      sourceRun!.style,
      { x: 40, y: 40, w: 180, h: sourceRun!.style.fontSizePt },
      context,
    )).toBe(true);

    const reopened = await getDocument({ data: (await pdf.save()).slice(), verbosity: 0 }).promise;
    openDocuments.push(reopened);
    const content = await (await reopened.getPage(1)).getTextContent();
    expect(content.items.some((item) => 'str' in item && item.str === probe)).toBe(true);
  });

  it('rejects Type0 and non-embedded resources even when their BaseFont names match', async () => {
    const originalBytes = new Uint8Array(
      await readFile('public/samples/RAHUL RAJPUT RESUME.pdf'),
    );
    const pdf = await PDFDocument.load(originalBytes, { updateMetadata: false });
    const context = makeContext(pdf);
    const baseStyle = {
      fontName: 'sans-serif',
      fontSizePt: 10,
      bold: false,
      italic: false,
      color: { r: 0, g: 0, b: 0 },
    } as const;

    registerPdfJsFontReference('type0-test', {
      name: 'ABCDEE+Lucida Sans Unicode',
      type: 'CIDFontType2',
    });
    registerPdfJsFontReference('missing-test', {
      name: 'Arial',
      type: 'TrueType',
      missingFile: true,
    });

    expect(resolvePageFontResource(context, { ...baseStyle, fontRef: 'type0-test' })).toBeNull();
    expect(resolvePageFontResource(context, { ...baseStyle, fontRef: 'missing-test' })).toBeNull();
  });

  it('falls back instead of corrupting characters outside the strict byte path', async () => {
    const originalBytes = new Uint8Array(
      await readFile('public/samples/RAHUL RAJPUT RESUME.pdf'),
    );
    const pdf = await PDFDocument.load(originalBytes, { updateMetadata: false });
    const context = makeContext(pdf);
    registerPdfJsFontReference('simple-test', {
      name: 'ABCDEE+Lucida Sans Unicode',
      type: 'TrueType',
    });

    expect(drawTextWithPageFont(
      'Unsupported • glyph',
      {
        fontName: 'sans-serif',
        fontRef: 'simple-test',
        fontSizePt: 10,
        bold: false,
        italic: false,
        color: { r: 0, g: 0, b: 0 },
      },
      { x: 20, y: 20, w: 100, h: 10 },
      context,
    )).toBe(false);
    expect(drawTextWithPageFont(
      'Added export bullet',
      {
        fontName: 'sans-serif',
        fontRef: 'simple-test',
        fontSizePt: 10,
        bold: false,
        italic: false,
        color: { r: 0, g: 0, b: 0 },
      },
      { x: 20, y: 20, w: 100, h: 10 },
      context,
    )).toBe(false);
  });
});
