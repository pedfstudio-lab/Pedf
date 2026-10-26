import { passwordProblem } from '@/lib/lockPdf/password';
import { MAX_LOCK_BYTES } from '@/lib/lockPdf/protocol';
import type { ToolOptions } from './types';

export interface LockOptionsValue extends ToolOptions { password: string; confirmation: string }
export const DEFAULT_LOCK_OPTIONS: LockOptionsValue = { password: '', confirmation: '' };
export function parseLockOptions(options: ToolOptions): LockOptionsValue {
  return { password: typeof options.password === 'string' ? options.password : '',
    confirmation: typeof options.confirmation === 'string' ? options.confirmation : '' };
}
export function lockProblem(options: ToolOptions, inputs?: File[]): string | undefined {
  if (inputs?.some(file => file.size > MAX_LOCK_BYTES)) return 'Choose a PDF smaller than 100 MB.';
  const value = parseLockOptions(options);
  return passwordProblem(value.password, value.confirmation);
}
