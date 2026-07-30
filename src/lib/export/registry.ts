import { drawCover } from './handlers/cover';
import { drawImage } from './handlers/image';
import { drawText } from './handlers/text';
import type { PageExportContext } from './context';
import type { Edit } from './types';

export type EditHandler<E extends Edit = Edit> = (
  edit: E,
  context: PageExportContext,
) => void | Promise<void>;

export type HandlerRegistry = {
  [Kind in Edit['kind']]: EditHandler<Extract<Edit, { kind: Kind }>>;
};

/** Adding an Edit kind without adding its handler is a compile-time error here. */
export const HANDLERS: HandlerRegistry = {
  text: drawText,
  cover: drawCover,
  image: drawImage,
};
