import { wasUnlocked } from '@/lib/pdf/protection';
import { isPdf } from '@/lib/site/pdfFile';
import { ToolError } from './errors';
import { outputName } from './pdfIo';
import type { ToolContext, ToolDefinition, ToolOptions, ToolOutput } from './types';

export const NOTHING_TO_UNLOCK = 'This PDF has no password or restrictions, so there is nothing to unlock. You can use it as it is.';
/** Removing a PDF's protection is only lawful for files you own or may open (see the Terms, section 6). */
export const UNLOCK_RIGHTS_NOTE = 'Only unlock PDFs you own or have permission to open.';
/** Every tool removes a PDF's restrictions as it's added, so the reminder sits on that file's card. */
export const UNPROTECTED_FILE_NOTE = 'Its password or restrictions were removed on this device. Only use PDFs you own or have permission to change.';

/**
 * The tool page unlocks every PDF on the device as it is added (asking for the password when one is
 * needed), so by the time this runs the file is already the unlocked copy. This just hands it back.
 */
export async function run(inputs: File[], _options: ToolOptions, ctx: ToolContext): Promise<ToolOutput[]> {
  ctx.signal.throwIfAborted();
  const file = inputs[0];
  if (inputs.length !== 1 || !file || !isPdf(file)) throw new ToolError('Choose one PDF file to unlock.');
  if (!wasUnlocked(file)) throw new ToolError(NOTHING_TO_UNLOCK);
  ctx.onProgress(0, 1, 'Unlocking your PDF…');
  const bytes = new Uint8Array(await file.arrayBuffer());
  ctx.signal.throwIfAborted();
  ctx.onProgress(1, 1, 'Unlocked PDF ready');
  return [{ name: outputName(file, 'unlocked'), bytes, mime: 'application/pdf',
    note: { text: 'This copy opens without a password, so keep it somewhere safe.', tone: 'ok' } }];
}

export const unlockTool: ToolDefinition = {
  slug: 'unlock', title: 'Unlock PDF',
  description: 'Remove the password from a PDF you can open, so it opens without one. You need to know the password.',
  rightsNote: UNLOCK_RIGHTS_NOTE,
  accepts: 'pdf', multiple: false, defaultOptions: {}, run,
};
