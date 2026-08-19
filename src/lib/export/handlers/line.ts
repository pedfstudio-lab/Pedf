import { rgb } from 'pdf-lib';
import type { LineEdit } from '../types';
import type { EditHandler } from '../registry';

/** Draw an axis-aligned divider in unrotated PDF user space. */
export const drawLine: EditHandler<LineEdit> = (edit, context) => {
  context.page.drawLine({
    start: { x: edit.x1, y: edit.y1 },
    end: { x: edit.x2, y: edit.y2 },
    thickness: edit.thicknessPt,
    color: rgb(edit.color.r, edit.color.g, edit.color.b),
  });
};
