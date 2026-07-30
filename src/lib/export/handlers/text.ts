import { notImplemented } from '@/lib/util/assert';
import { isIndicRun } from '../scriptRouting';
import type { TextEdit } from '../types';
import type { EditHandler } from '../registry';

/** Routing seam only; real English and Indic implementations belong to later tasks. */
export const drawText: EditHandler<TextEdit> = (edit) =>
  notImplemented(
    isIndicRun(edit.text)
      ? 'Indic text export / Path A (Task 13)'
      : 'English text export (Task 10)',
  );
