import { PDFHexString, PDFName, beginText, endText, popGraphicsState, pushGraphicsState, setFillingColor,
  setStrokingColor, setFontAndSize, setTextMatrix, showText, rgb, setTextRenderingMode, TextRenderingMode } from 'pdf-lib';
import type { PDFDocument, PDFPage, PDFRef } from 'pdf-lib';
import type { PageExportContext } from './context';
import type { TextStyle } from './types';

const fonts = new WeakMap<PDFDocument, PDFRef>();
const pageNames = new WeakMap<PDFPage, PDFName>();
/** A vector glyph with Unicode metadata, so exported arrows remain readable list markers. */
function arrowFont(context: PageExportContext): PDFName {
  const cachedName = pageNames.get(context.page); if (cachedName) return cachedName;
  let ref = fonts.get(context.pdf);
  if (!ref) {
    const charProc = context.pdf.context.register(context.pdf.context.flateStream(
      '780 0 -20 0 800 720 d1\n25 w\n0 40 m 780 350 l 0 700 l 220 350 l h S\n0 40 m 780 350 l 220 350 l h f\n'));
    const unicode = context.pdf.context.register(context.pdf.context.flateStream(
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Task76Arrow def /CMapType 2 def 1 begincodespacerange <41> <41> endcodespacerange 1 beginbfchar <41> <27A2> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'));
    ref = context.pdf.context.register(context.pdf.context.obj({ Type:'Font',Subtype:'Type3',Name:'Task76Arrow',
      FontBBox:[-20,0,800,720],FontMatrix:[0.001,0,0,0.001,0,0],CharProcs:{arrow:charProc},
      Encoding:{Type:'Encoding',Differences:[65,'arrow']},FirstChar:65,LastChar:65,Widths:[780],Resources:{},ToUnicode:unicode }));
    fonts.set(context.pdf,ref);
  }
  const name = context.page.node.newFontDictionaryKey('Task76Arrow');
  context.page.node.setFontDictionary(name,ref); pageNames.set(context.page,name); return name;
}
export function markerShapeWidth(style: TextStyle): number { return style.fontSizePt * 0.78; }
export function drawArrowMarker(style: TextStyle, x: number, y: number, context: PageExportContext): void {
  const font = arrowFont(context), color = rgb(style.color.r,style.color.g,style.color.b);
  context.page.pushOperators(pushGraphicsState(),setFillingColor(color),setStrokingColor(color),beginText(),
    setTextRenderingMode(TextRenderingMode.Fill),setFontAndSize(font,style.fontSizePt),setTextMatrix(1,0,0,1,x,y),
    showText(PDFHexString.of('41')),endText(),popGraphicsState());
}
