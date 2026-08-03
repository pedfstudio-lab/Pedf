import { StandardFonts } from 'pdf-lib';
import type { PDFDocument, PDFFont } from 'pdf-lib';
import { classifyFontFamily } from '@/lib/pdf/textContent';
import type { FontFamilyClass } from '@/lib/pdf/textContent';
import type { PageExportContext } from './context';
import type { TextStyle } from './types';

const cache = new WeakMap<PDFDocument, Map<StandardFonts, PDFFont>>();

const KNOWN_FONT = /times|georgia|serif|courier|mono|consolas|helvetica|arial|sans|inter|roboto/i;

export function standardFontFor(
  family: FontFamilyClass,
  bold: boolean,
  italic: boolean,
): StandardFonts {
  if (family === 'serif') {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (family === 'mono') {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold) return StandardFonts.CourierBold;
    if (italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

export async function resolveEnglishFont(
  style: TextStyle,
  context: PageExportContext,
): Promise<PDFFont> {
  const family = classifyFontFamily(style.fontName);
  const standardFont = standardFontFor(family, style.bold, style.italic);

  if (!KNOWN_FONT.test(style.fontName)) {
    context.warnings.push(
      `Font '${style.fontName}' substituted with Helvetica; widths/kerning may differ.`,
    );
  }

  let documentCache = cache.get(context.pdf);
  if (!documentCache) {
    documentCache = new Map();
    cache.set(context.pdf, documentCache);
  }

  let font = documentCache.get(standardFont);
  if (!font) {
    font = context.pdf.embedStandardFont(standardFont);
    documentCache.set(standardFont, font);
  }
  return font;
}
