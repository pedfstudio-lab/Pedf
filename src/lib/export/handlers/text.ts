import { rgb } from 'pdf-lib';
import type { PDFFont } from 'pdf-lib';
import { isIndicRun } from '../scriptRouting';
import { drawIndicTextPatch } from '../pathA';
import { resolveEnglishFont } from '../englishFont';
import { drawSpanWithPageFont, measureTextWithPageFont } from '../embeddedFont';
import type { TextEdit, TextStyle } from '../types';
import type { EditHandler } from '../registry';
import { effectiveTextSpanStyle } from '@/lib/edit/richText';
import { isArrowBullet } from '@/lib/pdf/symbolBullets';
import { drawArrowMarker, markerShapeWidth } from '../markerShapes';
import type { PageExportContext } from '../context';

function alignedTextX(edit: TextEdit, textWidth: number): number {
  const align = edit.align ?? 'left';
  if (align === 'left') return edit.rect.x;
  const left = edit.alignLeftPt ?? edit.rect.x;
  const width = edit.alignWidthPt ?? edit.rect.w;
  return align === 'center'
    ? left + (width - textWidth) / 2
    : left + width - textWidth;
}

function exportStyle(style: TextStyle): TextStyle {
  // Turning B off on an intrinsically-bold face cannot reuse that face; doing
  // so would make the control lie. Old projects without sourceBold keep their
  // legacy font-reuse behaviour.
  return style.sourceBold === true && !style.bold
    ? { ...style, fontRef: undefined }
    : style;
}

function syntheticBold(style: TextStyle): boolean {
  return style.bold && (style.sourceStrokeBold === true || style.sourceBold !== true);
}

interface PreparedText { text: string; style: TextStyle; width: number; font?: PDFFont; arrow?: boolean }
async function prepareText(text: string, style: TextStyle, context: PageExportContext): Promise<PreparedText[]> {
  const parts = text.split(/([➢\uF0D8])/u).filter(Boolean), result: PreparedText[] = [];
  for (const part of parts) {
    if (isArrowBullet(part)) { result.push({ text:'➢',style,width:markerShapeWidth(style),arrow:true }); continue; }
    const pageWidth = measureTextWithPageFont(part,style,context);
    if (pageWidth !== null) { result.push({text:part,style,width:pageWidth}); continue; }
    const font = await resolveEnglishFont(style,context);
    try { result.push({ text:part,style,width:font.widthOfTextAtSize(part,style.fontSizePt),font }); }
    catch {
      let safe = '';
      const flush = () => { if (safe) result.push({text:safe,style,width:font.widthOfTextAtSize(safe,style.fontSizePt),font}); safe = ''; };
      for (const character of part) {
        try { font.encodeText(character); safe += character; }
        catch {
          flush();
          const warning = `Skipped unsupported character U+${character.codePointAt(0)!.toString(16).toUpperCase()} on page ${context.geometry.pageIndex + 1}: the selected font cannot encode it.`;
          if (!context.warnings.includes(warning)) context.warnings.push(warning);
        }
      }
      flush();
    }
  }
  return result;
}

/** Draw English with a cached standard font; Indic remains routed to Path A. */
export const drawText: EditHandler<TextEdit> = async (edit, context) => {
  // Task 11B rich spans are English-only; Indic keeps the single whole-run Path-A route.
  if (isIndicRun(edit.text)) {
    await drawIndicTextPatch(edit, context);
    return;
  }

  const measured = edit.spans
    ? (await Promise.all(edit.spans.filter(span => span.text).map(span => prepareText(span.text,exportStyle(effectiveTextSpanStyle(edit.style,span)),context)))).flat()
    : await prepareText(edit.text,exportStyle(edit.style),context);
  let cursorX = alignedTextX(edit,measured.reduce((sum,item)=>sum+item.width,0));
  for (const item of measured) {
    if (item.arrow) drawArrowMarker(item.style,cursorX,edit.rect.y,context);
    else {
      const advance = drawSpanWithPageFont(item.text,item.style,cursorX,edit.rect.y,syntheticBold(item.style),item.style.italic,context);
      if (advance === null && item.font) context.page.drawText(item.text,{
        x:cursorX,y:edit.rect.y,size:item.style.fontSizePt,font:item.font,
        color:rgb(item.style.color.r,item.style.color.g,item.style.color.b),
      });
    }
    cursorX += item.width;
  }
};
