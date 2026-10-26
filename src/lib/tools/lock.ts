import { LockOptions } from '@/components/tools/LockOptions';
import { lockPdf } from '@/lib/lockPdf/client';
import { LockPdfError } from '@/lib/lockPdf/protocol';
import { ToolError } from './errors';
import { DEFAULT_LOCK_OPTIONS, lockProblem, parseLockOptions } from './lockOptions';
import { outputName } from './pdfIo';
import { isPdf } from '@/lib/site/pdfFile';
import type { ToolContext, ToolDefinition, ToolOptions, ToolOutput } from './types';

export async function run(inputs: File[], options: ToolOptions, ctx: ToolContext): Promise<ToolOutput[]> {
  ctx.signal.throwIfAborted();
  if (inputs.length !== 1 || !isPdf(inputs[0]!)) throw new ToolError('Choose one PDF file to lock.');
  const problem = lockProblem(options, inputs);
  if (problem) throw new ToolError(problem);
  const value = parseLockOptions(options);
  const file = inputs[0]!;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    ctx.signal.throwIfAborted();
    ctx.onProgress(0, 2, 'Preparing secure PDF locking…');
    const output = await lockPdf(bytes, value.password, ctx.signal, phase => ctx.onProgress(phase === 'checking' ? 0 : 1, 2,
      phase === 'checking' ? 'Checking your PDF…' : 'Locking your PDF…'));
    ctx.signal.throwIfAborted();
    ctx.onProgress(2, 2, 'Locked PDF ready');
    return [{ name: outputName(file, 'locked'), bytes: output, mime: 'application/pdf', canOpenInEditor: false,
      note: { text: 'Password-protected PDF. Share the password separately and keep a safe copy of it.', tone: 'ok' } }];
  } catch (error) {
    if (error instanceof LockPdfError) throw new ToolError(error.message);
    throw error;
  } finally { value.password = ''; value.confirmation = ''; }
}

export const lockTool: ToolDefinition = {
  slug: 'lock', title: 'Lock PDF', description: 'Set a password so only people you share it with can open your PDF.',
  accepts: 'pdf', multiple: false, defaultOptions: DEFAULT_LOCK_OPTIONS, Options: LockOptions, icon: '🔒',
  sensitiveOptions: true, canRun: lockProblem, run,
};
