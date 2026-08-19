import { rgb } from 'pdf-lib';
import { isIndicRun } from '../scriptRouting';
import { drawIndicTextPatch } from '../pathA';
import { resolveEnglishFont } from '../englishFont';
import { drawTextWithPageFont } from '../embeddedFont';
import type { TextEdit } from '../types';
import type { EditHandler } from '../registry';

/** Draw English with a cached standard font; Indic remains routed to Path A. */
export const drawText: EditHandler<TextEdit> = async (edit, context) => {
  // Task 11B rich spans are English-only; Indic keeps the single whole-run Path-A route.
  if (isIndicRun(edit.text)) {
    await drawIndicTextPatch(edit, context);
    return;
  }

  if (edit.spans) {
    let cursorX = edit.rect.x;
    for (const span of edit.spans) {
      if (!span.text) continue;
      const font = await resolveEnglishFont({
        ...edit.style,
        bold: span.bold,
        italic: span.italic,
      }, context);
      context.page.drawText(span.text, {
        x: cursorX,
        y: edit.rect.y,
        size: edit.style.fontSizePt,
        font,
        color: rgb(edit.style.color.r, edit.style.color.g, edit.style.color.b),
      });
      cursorX += font.widthOfTextAtSize(span.text, edit.style.fontSizePt);
    }
    return;
  }

  if (drawTextWithPageFont(edit.text, edit.style, edit.rect, context)) return;

  const font = await resolveEnglishFont(edit.style, context);
  context.page.drawText(edit.text, {
    x: edit.rect.x,
    y: edit.rect.y,
    size: edit.style.fontSizePt,
    font,
    color: rgb(edit.style.color.r, edit.style.color.g, edit.style.color.b),
  });
};
