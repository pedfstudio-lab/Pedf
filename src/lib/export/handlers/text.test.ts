import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { resolvePageFontResource } from '../embeddedFont';
import type { PageExportContext } from '../context';
import type { TextEdit } from '../types';
import { extractTextRuns } from '@/lib/pdf/textContent';
import { resolveTextPaint, textPaintForItems } from '@/lib/pdf/textPaint';
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
    run.style.sourceBold === false && resolvePageFontResource(context, run.style)
  ));
  if (!sourceRun) throw new Error('Résumé regular body font was not resolved');
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

  it('does not add a second synthetic weight to an intrinsically bold source face', async () => {
    const { context, style } = await makeResumeContext();
    const fallbackDraw = vi.spyOn(context.page, 'drawText');
    const pushed = vi.spyOn(context.page, 'pushOperators');
    const edit: TextEdit = {
      id: 'source-bold',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 60, y: 245, w: 180, h: style.fontSizePt },
      z: 1,
      text: 'already bold',
      style: { ...style, bold: true, sourceBold: true },
    };

    await drawText(edit, context);

    const operators = pushed.mock.calls.flat().map((operator) => operator.toString()).join('\n');
    expect(fallbackDraw).not.toHaveBeenCalled();
    expect(operators).not.toContain('2 Tr');
    expect(operators).not.toContain(' w');
  });

  it('preserves a source mode-2 outline on an intrinsically bold face exactly once', async () => {
    const { context, style } = await makeResumeContext();
    const pushed = vi.spyOn(context.page, 'pushOperators');
    const edit: TextEdit = {
      id: 'source-stroke-bold',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 60, y: 242, w: 180, h: style.fontSizePt },
      z: 1,
      text: 'outlined heavy face',
      style: {
        ...style,
        bold: true,
        sourceBold: true,
        sourceStrokeBold: true,
      },
    };

    await drawText(edit, context);

    const operators = pushed.mock.calls.flat().map((operator) => operator.toString()).join('\n');
    expect(operators.match(/2 Tr/g)).toHaveLength(1);
    expect(operators.match(/ w/g)).toHaveLength(1);
  });

  it('adds synthetic weight once when bold is requested on a non-bold source face', async () => {
    const { context, style } = await makeResumeContext();
    const pushed = vi.spyOn(context.page, 'pushOperators');
    const edit: TextEdit = {
      id: 'user-bold',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 60, y: 240, w: 180, h: style.fontSizePt },
      z: 1,
      text: 'make bold',
      style: { ...style, bold: true, sourceBold: false },
    };

    await drawText(edit, context);

    const operators = pushed.mock.calls.flat().map((operator) => operator.toString()).join('\n');
    expect(operators).toContain('2 Tr');
    expect(operators).toContain(' w');
  });

  it('recognises its own fill-and-outline bold after export and reopen', async () => {
    const { context, style } = await makeResumeContext();
    const text = 'make bold';
    const edit: TextEdit = {
      id: 'roundtrip-bold',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 60, y: 40, w: 180, h: style.fontSizePt },
      z: 1,
      text,
      style: {
        ...style,
        bold: true,
        sourceBold: false,
        color: { r: 0.2, g: 0.2, b: 0.2 },
        colorKnown: true,
      },
    };

    await drawText(edit, context);
    const reopened = await getDocument({
      data: (await context.pdf.save()).slice(),
      verbosity: 0,
    }).promise;
    openDocuments.push(reopened);
    const reopenedPage = await reopened.getPage(1);
    const [content, operators] = await Promise.all([
      reopenedPage.getTextContent(),
      reopenedPage.getOperatorList(),
    ]);
    const itemIndex = content.items.findIndex((item) => 'str' in item && item.str === text);
    const item = content.items[itemIndex];
    const paints = textPaintForItems(content.items, operators);
    const rawPaint = itemIndex >= 0 ? paints?.[itemIndex] : undefined;
    const fontSize = item && 'transform' in item
      ? Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0)
      : 0;
    expect(rawPaint && resolveTextPaint(rawPaint, fontSize)).toMatchObject({
      renderingMode: 2,
      supported: true,
      syntheticBold: true,
    });
    const runs = await extractTextRuns(reopenedPage, 0);
    const roundTrip = runs.find((run) => run.text === text);

    expect(roundTrip?.style.bold).toBe(true);
    expect(roundTrip?.style.sourceStrokeBold).toBe(true);
    expect(roundTrip?.style.colorKnown).not.toBe(false);
    expect(roundTrip?.style.color).toMatchObject({ r: 0.2, g: 0.2, b: 0.2 });
  });

  it('does not reuse an intrinsically bold source face after bold is turned off', async () => {
    const { context, style } = await makeResumeContext();
    const fallbackDraw = vi.spyOn(context.page, 'drawText');
    const edit: TextEdit = {
      id: 'source-bold-off',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 60, y: 235, w: 180, h: style.fontSizePt },
      z: 1,
      text: 'regular now',
      style: { ...style, bold: false, sourceBold: true },
    };

    await drawText(edit, context);

    expect(fallbackDraw).toHaveBeenCalledTimes(1);
    expect(fallbackDraw.mock.calls[0]?.[1]?.font?.name).toBe('Helvetica');
  });

  it('draws each rich span with its own colour override', async () => {
    const context = await makeContext();
    const draw = vi.spyOn(context.page, 'drawText');
    const edit: TextEdit = {
      id: 'span-colours',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 20, y: 220, w: 180, h: 12 },
      z: 1,
      text: 'black red',
      spans: [
        { text: 'black ', bold: false, italic: false },
        { text: 'red', bold: false, italic: false, color: { r: 0.8, g: 0.1, b: 0.2 } },
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

    expect(draw.mock.calls[0]?.[1]?.color).toMatchObject({ red: 0, green: 0, blue: 0 });
    expect(draw.mock.calls[1]?.[1]?.color).toMatchObject({ red: 0.8, green: 0.1, blue: 0.2 });
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
