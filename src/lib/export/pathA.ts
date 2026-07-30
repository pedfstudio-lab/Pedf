import { notImplemented } from '@/lib/util/assert';
import type { PageExportContext } from './context';
import type { TextEdit } from './types';

/** Task 13 replaces this guard with browser-shaped Indic raster patches. */
export async function drawIndicTextPatch(
  edit: TextEdit,
  context: PageExportContext,
): Promise<void> {
  void edit;
  void context;
  notImplemented('Indic text export / Path A (Task 13)');
}
