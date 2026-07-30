import type { PDFFont } from 'pdf-lib';
import { notImplemented } from '@/lib/util/assert';
import type { PageExportContext } from './context';
import type { TextStyle } from './types';

/** Task 10 replaces this guard with the standard-font mapping table. */
export async function resolveEnglishFont(
  style: TextStyle,
  context: PageExportContext,
): Promise<PDFFont> {
  void style;
  void context;
  return notImplemented('English font mapping (Task 10)');
}
