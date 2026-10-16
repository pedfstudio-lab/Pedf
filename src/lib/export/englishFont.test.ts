import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { PageExportContext } from './context';
import { resolveEnglishFont, standardFontFor } from './englishFont';
import type { TextStyle } from './types';

describe('standardFontFor', () => {
  it.each([
    ['sans', false, false, StandardFonts.Helvetica],
    ['sans', true, false, StandardFonts.HelveticaBold],
    ['sans', false, true, StandardFonts.HelveticaOblique],
    ['sans', true, true, StandardFonts.HelveticaBoldOblique],
    ['serif', false, false, StandardFonts.TimesRoman],
    ['serif', true, false, StandardFonts.TimesRomanBold],
    ['serif', false, true, StandardFonts.TimesRomanItalic],
    ['serif', true, true, StandardFonts.TimesRomanBoldItalic],
    ['mono', false, false, StandardFonts.Courier],
    ['mono', true, false, StandardFonts.CourierBold],
    ['mono', false, true, StandardFonts.CourierOblique],
    ['mono', true, true, StandardFonts.CourierBoldOblique],
  ] as const)('maps %s bold=%s italic=%s', (family, bold, italic, expected) => {
    expect(standardFontFor(family, bold, italic)).toBe(expected);
  });
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

describe('resolveEnglishFont', () => {
  it('caches subset-embedded metric twins per PDF document', async () => {
    const context = await makeContext();
    const style: TextStyle = {
      fontName: 'Arial',
      fontSizePt: 12,
      bold: true,
      italic: false,
      color: { r: 0, g: 0, b: 0 },
    };

    const first = await resolveEnglishFont(style, context);
    const second = await resolveEnglishFont(style, context);
    expect(first).toBe(second);
    expect(first.name).toBe('LiberationSans-Bold');
    expect(context.warnings).toEqual([]);
  });

  it('uses the local generic and reports unavailable calibration for an unknown font', async () => {
    const context = await makeContext();
    const font = await resolveEnglishFont(
      {
        fontName: 'MysteryGrotesk',
        fontSizePt: 12,
        bold: false,
        italic: false,
        color: { r: 0, g: 0, b: 0 },
      },
      context,
    );

    expect(font.name).toBe('LiberationSans');
    expect(context.warnings).toEqual([
      "Font 'MysteryGrotesk' substituted with LiberationSans; no source widths available for calibration.",
    ]);
  });
});
