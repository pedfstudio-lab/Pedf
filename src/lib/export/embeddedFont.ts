import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFString,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setFillingRgbColor,
  setFontAndSize,
  setTextMatrix,
  showText,
} from 'pdf-lib';
import type { PageExportContext } from './context';
import type { PdfRect, TextStyle } from './types';

interface PdfJsFontReference {
  readonly name: string;
  readonly type?: string;
  readonly isType3Font?: boolean;
  readonly missingFile?: boolean;
}

interface PdfJsFontObject {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly isType3Font?: unknown;
  readonly missingFile?: unknown;
}

export interface PageFontResource {
  readonly name: PDFName;
  readonly dictionary: PDFDict;
}

const pdfJsFonts = new Map<string, PdfJsFontReference>();

/** Retain the BaseFont identity that pdf.js keeps beside its browser FontFace. */
export function registerPdfJsFontReference(fontRef: string, value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const font = value as PdfJsFontObject;
  if (typeof font.name !== 'string' || font.name.trim() === '') return;
  pdfJsFonts.set(fontRef, {
    name: font.name,
    ...(typeof font.type === 'string' ? { type: font.type } : {}),
    ...(typeof font.isType3Font === 'boolean' ? { isType3Font: font.isType3Font } : {}),
    ...(typeof font.missingFile === 'boolean' ? { missingFile: font.missingFile } : {}),
  });
}

function normalizedFontName(value: string): string {
  return value.trim().replace(/^\//, '').replace(/\s+/g, ' ').toLowerCase();
}

function isSupportedPdfJsFont(font: PdfJsFontReference): boolean {
  return (
    (font.type === 'TrueType' || font.type === 'Type1') &&
    font.isType3Font !== true &&
    font.missingFile !== true
  );
}

function hasWinAnsiEncoding(font: PDFDict): boolean {
  const rawEncoding = font.get(PDFName.of('Encoding'));
  const encoding = rawEncoding ? font.context.lookup(rawEncoding) : undefined;
  if (encoding instanceof PDFName) return encoding.decodeText() === 'WinAnsiEncoding';
  if (encoding instanceof PDFDict) {
    return encoding.lookupMaybe(PDFName.of('BaseEncoding'), PDFName)?.decodeText() === 'WinAnsiEncoding';
  }
  return false;
}

function isEmbedded(font: PDFDict): boolean {
  const descriptor = font.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
  return Boolean(
    descriptor?.get(PDFName.of('FontFile')) ||
    descriptor?.get(PDFName.of('FontFile2')) ||
    descriptor?.get(PDFName.of('FontFile3')),
  );
}

function isSupportedResource(font: PDFDict): boolean {
  const subtype = font.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
  return (
    (subtype === 'TrueType' || subtype === 'Type1') &&
    hasWinAnsiEncoding(font) &&
    isEmbedded(font)
  );
}

/** Match a pdf.js loaded font to a reusable simple font already present on this page. */
export function resolvePageFontResource(
  context: PageExportContext,
  style: TextStyle,
): PageFontResource | null {
  if (!style.fontRef) return null;
  const source = pdfJsFonts.get(style.fontRef);
  if (!source || !isSupportedPdfJsFont(source)) return null;

  const resources = context.page.node.Resources();
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fonts) return null;

  const expectedName = normalizedFontName(source.name);
  for (const [resourceName] of fonts.entries()) {
    const font = fonts.lookupMaybe(resourceName, PDFDict);
    if (!font || !isSupportedResource(font)) continue;
    const baseFont = font.lookupMaybe(PDFName.of('BaseFont'), PDFName);
    if (!baseFont || normalizedFontName(baseFont.decodeText()) !== expectedName) continue;
    return { name: resourceName, dictionary: font };
  }
  return null;
}

function isSafePdfString(text: string, font: PDFDict): boolean {
  const firstChar = font.lookupMaybe(PDFName.of('FirstChar'), PDFNumber)?.asNumber();
  const widths = font.lookupMaybe(PDFName.of('Widths'), PDFArray);
  if (firstChar === undefined || !widths) return false;

  return [...text].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0xff) return false;
    if (character === ' ') return true;
    return (widths.lookupMaybe(code - firstChar, PDFNumber)?.asNumber() ?? 0) > 0;
  });
}

/** Draw through a page-owned WinAnsi font. Returns false when the strict path is unsupported. */
export function drawTextWithPageFont(
  text: string,
  style: TextStyle,
  rect: PdfRect,
  context: PageExportContext,
): boolean {
  if (!text) return false;
  const resource = resolvePageFontResource(context, style);
  if (!resource || !isSafePdfString(text, resource.dictionary)) return false;

  // PDFString is a valid Tj operand. pdf-lib's public showText declaration is
  // unnecessarily narrowed to PDFHexString, so bridge only this operator arg.
  const literalText = PDFString.of(text) as unknown as Parameters<typeof showText>[0];

  context.page.pushOperators(
    pushGraphicsState(),
    beginText(),
    setFillingRgbColor(style.color.r, style.color.g, style.color.b),
    setFontAndSize(resource.name, style.fontSizePt),
    setTextMatrix(1, 0, 0, 1, rect.x, rect.y),
    showText(literalText),
    endText(),
    popGraphicsState(),
  );
  return true;
}
