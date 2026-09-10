import { degrees } from 'pdf-lib';
import { RotateOptions } from '@/components/tools/RotateOptions';
import { ToolError } from './errors';
import { loadPdfLib, outputName, savePdf } from './pdfIo';
import { selectedPageIndices } from './pdfToJpgOptions';
import {
  DEFAULT_ROTATE_OPTIONS,
  nextRotation,
  parseRotateOptions,
  rotationDelta,
} from './rotateOptions';
import type { ToolContext, ToolDefinition, ToolOptions, ToolOutput } from './types';

export const ROTATE_INPUT_ERROR = 'Choose one PDF file to rotate.';
export const NO_TURN_ERROR = 'Click Left or Right to choose the direction first.';

export async function run(inputs: File[], options: ToolOptions, ctx: ToolContext): Promise<ToolOutput[]> {
  const { signal, onProgress } = ctx;
  signal.throwIfAborted();
  if (inputs.length !== 1) throw new ToolError(ROTATE_INPUT_ERROR);
  const file = inputs[0]!;
  const value = parseRotateOptions(options);
  if (value.turns === 0) throw new ToolError(NO_TURN_ERROR);
  const doc = await loadPdfLib(file);
  signal.throwIfAborted();
  const delta = rotationDelta(value.turns);
  const pageCount = doc.getPageCount();
  const pages = selectedPageIndices(value, pageCount);

  for (const [index, pageIndex] of pages.entries()) {
    signal.throwIfAborted();
    onProgress(index, pages.length, `Rotating page ${pageIndex + 1} of ${pageCount}`);
    signal.throwIfAborted();
    const page = doc.getPage(pageIndex);
    page.setRotation(degrees(nextRotation(page.getRotation().angle, delta)));
    if ((index + 1) % 50 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  signal.throwIfAborted();
  const bytes = await savePdf(doc);
  signal.throwIfAborted();
  onProgress(pages.length, pages.length, 'Rotated PDF ready');
  return [{ name: outputName(file, 'rotated'), bytes, mime: 'application/pdf' }];
}

export const rotateTool: ToolDefinition = {
  slug: 'rotate', title: 'Rotate PDF',
  description: 'Turn pages 90° or 180° — all of them, or only the ones you choose.',
  accepts: 'pdf', multiple: false, defaultOptions: DEFAULT_ROTATE_OPTIONS,
  canRun: (options) => parseRotateOptions(options).turns === 0 ? NO_TURN_ERROR : undefined,
  Options: RotateOptions, icon: '⟳', run,
};
