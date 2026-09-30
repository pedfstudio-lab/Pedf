import { rgb } from 'pdf-lib';
import { isIndicRun } from '../scriptRouting';
import { drawIndicTextPatch } from '../pathA';
import { resolveEnglishFont } from '../englishFont';
import { drawSpanWithPageFont, measureTextWithPageFont } from '../embeddedFont';
import type { TextEdit, TextStyle } from '../types';
import type { EditHandler } from '../registry';
import { effectiveTextSpanStyle } from '@/lib/edit/richText';

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

/** Draw English with a cached standard font; Indic remains routed to Path A. */
export const drawText: EditHandler<TextEdit> = async (edit, context) => {
  // Task 11B rich spans are English-only; Indic keeps the single whole-run Path-A route.
  if (isIndicRun(edit.text)) {
    await drawIndicTextPatch(edit, context);
    return;
  }

  if (edit.spans) {
    const measured = await Promise.all(edit.spans.filter((span) => span.text).map(async (span) => {
      const style = exportStyle(effectiveTextSpanStyle(edit.style, span));
      const pageFontWidth = measureTextWithPageFont(span.text, style, context);
      if (pageFontWidth !== null) return { span, style, width: pageFontWidth };
      const font = await resolveEnglishFont(style, context);
      return {
        span,
        style,
        width: font.widthOfTextAtSize(span.text, style.fontSizePt),
        font,
      };
    }));
    let cursorX = alignedTextX(
      edit,
      measured.reduce((total, item) => total + item.width, 0),
    );
    for (const item of measured) {
      const advance = drawSpanWithPageFont(
        item.span.text,
        item.style,
        cursorX,
        edit.rect.y,
        syntheticBold(item.style),
        item.style.italic,
        context,
      );
      if (advance === null && 'font' in item) {
        context.page.drawText(item.span.text, {
          x: cursorX,
          y: edit.rect.y,
          size: item.style.fontSizePt,
          font: item.font,
          color: rgb(item.style.color.r, item.style.color.g, item.style.color.b),
        });
      }
      cursorX += item.width;
    }
    return;
  }

  const style = exportStyle(edit.style);
  const pageFontWidth = measureTextWithPageFont(edit.text, style, context);
  if (pageFontWidth !== null) {
    drawSpanWithPageFont(
      edit.text,
      style,
      alignedTextX(edit, pageFontWidth),
      edit.rect.y,
      syntheticBold(style),
      style.italic,
      context,
    );
    return;
  }

  const font = await resolveEnglishFont(style, context);
  const textWidth = font.widthOfTextAtSize(edit.text, style.fontSizePt);
  context.page.drawText(edit.text, {
    x: alignedTextX(edit, textWidth),
    y: edit.rect.y,
    size: style.fontSizePt,
    font,
    color: rgb(style.color.r, style.color.g, style.color.b),
  });
};
