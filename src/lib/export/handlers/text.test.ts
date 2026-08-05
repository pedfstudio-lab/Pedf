import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { PageExportContext } from '../context';
import type { TextEdit } from '../types';
import { drawText } from './text';

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
});
