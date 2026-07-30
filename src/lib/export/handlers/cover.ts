import type { CoverEdit, Rgb } from '../types';
import type { EditHandler } from '../registry';

const WHITE: Rgb = { r: 1, g: 1, b: 1 };

/** Draw the foundational opaque patch used to hide existing page content. */
export const drawCover: EditHandler<CoverEdit> = (edit, context) => {
  const color =
    edit.color ??
    (edit.sampleBackground ? context.sampleBackground(edit.rect) : undefined) ??
    WHITE;
  context.drawRect(edit.rect, color);
};
