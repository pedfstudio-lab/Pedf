import { StandardFonts } from 'pdf-lib';
import type { PDFDocument, PDFFont } from 'pdf-lib';
import { classifyFontFamily } from '@/lib/pdf/textContent';
import type { FontFamilyClass } from '@/lib/pdf/textContent';
import type { PageExportContext } from './context';
import type { TextStyle } from './types';
import { loadFontBytes } from '@/lib/fonts/twinFonts';
import { matchFont } from '@/lib/fonts/fontMatch';
import { subsetSafeSfnt } from '@/lib/fonts/subsetSafeSfnt';

const cache = new WeakMap<PDFDocument, Map<StandardFonts, PDFFont>>();

const shipped = new WeakMap<PDFDocument, Map<string, Promise<PDFFont>>>();
let fontkit: Promise<typeof import('@pdf-lib/fontkit')> | undefined;

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
  const match = matchFont(style);
  if (!match.exact && style.fontWidthScale === undefined && !style.fontRef) {
    const warning = `Font '${style.fontIdentity ?? style.fontName}' substituted with ${match.family}; no source widths available for calibration.`;
    if (!context.warnings.includes(warning)) context.warnings.push(warning);
  }
  let fonts = shipped.get(context.pdf);
  if (!fonts) { fonts = new Map(); shipped.set(context.pdf, fonts); }
  if (!fonts.has(match.file)) fonts.set(match.file, (async () => {
    const [data, kit] = await Promise.all([loadFontBytes(match.file), fontkit ??= import('@pdf-lib/fontkit')]);
    // fontkit's ESM build has a default export, while its declaration file
    // exposes create(). Handle both module shapes (browser and Node tests).
    context.pdf.registerFontkit((kit as unknown as { default?: typeof kit }).default ?? kit);
    return context.pdf.embedFont(subsetSafeSfnt(data), { subset: true, features: { liga: false, kern: false } });
  })());
  try { return await fonts.get(match.file)!; }
  catch (error) {
    fonts.delete(match.file);
    const warning = `Font asset '${match.file}' could not be loaded; used ${standardFont}: ${String(error)}`;
    if (!context.warnings.includes(warning)) context.warnings.push(warning);
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
