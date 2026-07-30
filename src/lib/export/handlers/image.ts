import { notImplemented } from '@/lib/util/assert';
import type { ImageEdit } from '../types';
import type { EditHandler } from '../registry';

/** Guarded until Task 16 adds PNG embedding. */
export const drawImage: EditHandler<ImageEdit> = () => notImplemented('image export (Task 16)');
