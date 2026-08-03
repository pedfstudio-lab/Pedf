import { rgb } from 'pdf-lib';
import { isIndicRun } from '../scriptRouting';
import { drawIndicTextPatch } from '../pathA';
import { resolveEnglishFont } from '../englishFont';
import type { TextEdit } from '../types';
import type { EditHandler } from '../registry';

/** Draw English with a cached standard font; Indic remains routed to Path A. */
export const drawText: EditHandler<TextEdit> = async (edit, context) => {
  if (isIndicRun(edit.text)) {
    await drawIndicTextPatch(edit, context);
    return;
  }

  const font = await resolveEnglishFont(edit.style, context);
  context.page.drawText(edit.text, {
    x: edit.rect.x,
    y: edit.rect.y,
    size: edit.style.fontSizePt,
    font,
    color: rgb(edit.style.color.r, edit.style.color.g, edit.style.color.b),
  });
};
