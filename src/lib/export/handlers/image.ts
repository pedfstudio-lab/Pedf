import { imageMimeType } from '@/lib/images/imageFile';
import type { ImageEdit } from '../types';
import type { EditHandler } from '../registry';

/** Embed the user's original PNG/JPEG bytes and draw the exact supplied PDF-point rectangle. */
export const drawImage: EditHandler<ImageEdit> = async (edit, context) => {
  const mime = imageMimeType(edit.bytes);
  if (!mime) {
    throw new Error('Unsupported image format. Choose a PNG or JPEG file.');
  }
  const embedded = mime === 'image/png'
    ? await context.pdf.embedPng(edit.bytes)
    : await context.pdf.embedJpg(edit.bytes);
  context.page.drawImage(embedded, {
    x: edit.rect.x,
    y: edit.rect.y,
    width: edit.rect.w,
    height: edit.rect.h,
  });
};
