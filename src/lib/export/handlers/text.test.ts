import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { resolvePageFontResource } from '../embeddedFont';
import type { PageExportContext } from '../context';
import type { TextEdit } from '../types';
import { extractTextRuns } from '@/lib/pdf/textContent';
import { drawText } from './text';

const openDocuments: PDFDocumentProxy[] = [];

afterEach(async () => {
  await Promise.all(openDocuments.splice(0).map((document) => document.destroy()));
});

async function makeContext(): Promise<PageExportContext> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  return {
    pdf,
    page,
    geometry: {
      pageIndex: 0,
      widthPt: 300,
      heightPt: 400,
      rotation: 0,
      boxOffset: { x: 0, y: 0 },
    },
    warnings: [],
    drawRect: () => undefined,
    sampleBackground: () => undefined,
  };
}

async function makeResumeContext() {
  const bytes = new Uint8Array(await readFile('public/samples/RAHUL RAJPUT RESUME.pdf'));
  const browserDocument = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  openDocuments.push(browserDocument);
  const runs = await extractTextRuns(await browserDocument.getPage(1), 0);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = pdf.getPage(0);
  const context: PageExportContext = {
    pdf,
    page,
    geometry: {
      pageIndex: 0,
      widthPt: page.getWidth(),
      heightPt: page.getHeight(),
      rotation: 0,
      boxOffset: { x: 0, y: 0 },
    },
    warnings: [],
    drawRect: () => undefined,
    sampleBackground: () => undefined,
  };
  const sourceRun = runs.find((run) => (
    resolvePageFontResource(context, run.style)?.name.decodeText() === 'F2'
  ));
  if (!sourceRun) throw new Error('Résumé F2 body font was not resolved');
  return { context, style: sourceRun.style };
}

describe('drawText rich spans', () => {
  it('draws each styled span with its font and advances x by measured widths', async () => {
    const context = await makeContext();
    const draw = vi.spyOn(context.page, 'drawText');
    const edit: TextEdit = {
      id: 'rich-text',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 20, y: 300, w: 200, h: 14 },
      z: 1,
      text: 'plain bold italic',
      spans: [
        { text: 'plain ', bold: false, italic: false },
        { text: 'bold ', bold: true, italic: false },
        { text: 'italic', bold: false, italic: true },
      ],
      style: {
        fontName: 'Helvetica',
        fontSizePt: 12,
        bold: false,
        italic: false,
        color: { r: 0, g: 0, b: 0 },
      },
    };

    await drawText(edit, context);

    const regular = context.pdf.embedStandardFont(StandardFonts.Helvetica);
    const bold = context.pdf.embedStandardFont(StandardFonts.HelveticaBold);
    expect(draw).toHaveBeenCalledTimes(3);
    expect(draw.mock.calls.map(([text]) => text)).toEqual(['plain ', 'bold ', 'italic']);
    expect(draw.mock.calls[0]?.[1]?.x).toBe(20);
    expect(draw.mock.calls[1]?.[1]?.x).toBeCloseTo(
      20 + regular.widthOfTextAtSize('plain ', 12),
      6,
    );
    expect(draw.mock.calls[2]?.[1]?.x).toBeCloseTo(
      20 + regular.widthOfTextAtSize('plain ', 12) + bold.widthOfTextAtSize('bold ', 12),
      6,
    );
  });

  it('uses the page font for an embeddable bold span without invoking fallback drawing', async () => {
    const { context, style } = await makeResumeContext();
    const fallbackDraw = vi.spyOn(context.page, 'drawText');
    const edit: TextEdit = {
      id: 'embedded-rich-text',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 60, y: 250, w: 180, h: style.fontSizePt },
      z: 1,
      text: 'keeps face',
      spans: [{ text: 'keeps face', bold: true, italic: false }],
      style,
    };

    await drawText(edit, context);

    expect(fallbackDraw).not.toHaveBeenCalled();
  });

  it('falls back per span when the page font cannot encode its text', async () => {
    const { context, style } = await makeResumeContext();
    const fallbackDraw = vi.spyOn(context.page, 'drawText');
    const edit: TextEdit = {
      id: 'fallback-rich-text',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 60, y: 230, w: 180, h: style.fontSizePt },
      z: 1,
      text: '•',
      spans: [{ text: '•', bold: true, italic: false }],
      style,
    };

    await drawText(edit, context);

    expect(fallbackDraw).toHaveBeenCalledTimes(1);
    expect(fallbackDraw).toHaveBeenCalledWith('•', expect.any(Object));
  });

  it('draws mixed size and family spans on one baseline with matching advances', async () => {
    const context = await makeContext();
    const draw = vi.spyOn(context.page, 'drawText');
    const edit: TextEdit = {
      id: 'mixed-size-family',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 20, y: 260, w: 220, h: 20 },
      z: 1,
      text: 'Small Large',
      spans: [
        { text: 'Small ', bold: false, italic: false, fontSizePt: 10 },
        {
          text: 'Large',
          bold: false,
          italic: false,
          fontSizePt: 20,
          fontName: 'Times New Roman',
        },
      ],
      style: {
        fontName: 'Helvetica',
        fontSizePt: 12,
        bold: false,
        italic: false,
        color: { r: 0, g: 0, b: 0 },
      },
    };

    await drawText(edit, context);

    const small = context.pdf.embedStandardFont(StandardFonts.Helvetica);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(draw.mock.calls.map(([, options]) => options?.size)).toEqual([10, 20]);
    expect(draw.mock.calls.map(([, options]) => options?.y)).toEqual([260, 260]);
    expect(draw.mock.calls[1]?.[1]?.x).toBeCloseTo(
      20 + small.widthOfTextAtSize('Small ', 10),
      6,
    );
  });
});

it('draws an owned bullet glyph with the standard English font', async () => {
  const context = await makeContext();
  const edit: TextEdit = {
    id: 'bullet',
    kind: 'text',
    pageIndex: 0,
    rect: { x: 20, y: 300, w: 20, h: 10 },
    z: 1,
    text: '•',
    style: {
      fontName: 'Helvetica',
      fontSizePt: 10,
      bold: false,
      italic: false,
      color: { r: 0, g: 0, b: 0 },
    },
  };

  await expect(drawText(edit, context)).resolves.toBeUndefined();
  const bytes = await context.pdf.save();
  expect(bytes.length).toBeGreaterThan(100);
});

describe('drawText alignment', () => {
  it('centers replacement glyphs inside the stored alignment column', async () => {
    const context = await makeContext();
    const draw = vi.spyOn(context.page, 'drawText');
    const edit: TextEdit = {
      id: 'centered',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 30, y: 300, w: 240, h: 12 },
      z: 1,
      text: 'Centered title',
      align: 'center',
      alignLeftPt: 30,
      alignWidthPt: 240,
      style: {
        fontName: 'Helvetica',
        fontSizePt: 12,
        bold: false,
        italic: false,
        color: { r: 0, g: 0, b: 0 },
      },
    };

    await drawText(edit, context);

    const font = context.pdf.embedStandardFont(StandardFonts.Helvetica);
    const expectedX = 30 + (
      240 - font.widthOfTextAtSize(edit.text, edit.style.fontSizePt)
    ) / 2;
    expect(draw).toHaveBeenCalledTimes(1);
    expect(draw.mock.calls[0]?.[1]?.x).toBeCloseTo(expectedX, 6);
  });

  it('right-aligns rich spans by their combined measured width', async () => {
    const context = await makeContext();
    const draw = vi.spyOn(context.page, 'drawText');
    const edit: TextEdit = {
      id: 'right-rich',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 30, y: 280, w: 240, h: 12 },
      z: 1,
      text: 'Date 2026',
      spans: [
        { text: 'Date ', bold: false, italic: false },
        { text: '2026', bold: true, italic: false },
      ],
      align: 'right',
      alignLeftPt: 30,
      alignWidthPt: 240,
      style: {
        fontName: 'Helvetica',
        fontSizePt: 12,
        bold: false,
        italic: false,
        color: { r: 0, g: 0, b: 0 },
      },
    };

    await drawText(edit, context);

    const regular = context.pdf.embedStandardFont(StandardFonts.Helvetica);
    const bold = context.pdf.embedStandardFont(StandardFonts.HelveticaBold);
    const totalWidth = regular.widthOfTextAtSize('Date ', 12) + bold.widthOfTextAtSize('2026', 12);
    expect(draw.mock.calls[0]?.[1]?.x).toBeCloseTo(30 + 240 - totalWidth, 6);
  });
});
