import { fileKey } from './organizePlan';
import type { CompressLevel } from '@/lib/compress/levels';
import type { ToolOptions } from './types';

export type CompressChoice = CompressLevel | 'fit';
export type CompressLimitUnit = 'KB' | 'MB';

export interface CompressOptionsValue extends ToolOptions {
  level: CompressChoice;
  limitValue: number;
  limitUnit: CompressLimitUnit;
  acceptSignatureLoss: boolean;
  /** Internal panel state used by canRun; analysis itself stays in the File WeakMap. */
  analysisFileKey?: string;
  signed?: boolean;
}

export const DEFAULT_COMPRESS_OPTIONS: CompressOptionsValue = {
  level: 'medium',
  limitValue: 500,
  limitUnit: 'KB',
  acceptSignatureLoss: false,
};

export function parseCompressOptions(options: ToolOptions): CompressOptionsValue {
  const level: CompressChoice = options.level === 'light' || options.level === 'strong' || options.level === 'smallest' || options.level === 'fit'
    ? options.level : 'medium';
  const limitValue = options.limitValue === undefined ? DEFAULT_COMPRESS_OPTIONS.limitValue
    : typeof options.limitValue === 'number' && Number.isFinite(options.limitValue) ? options.limitValue : Number.NaN;
  return {
    level,
    limitValue,
    limitUnit: options.limitUnit === 'MB' ? 'MB' : 'KB',
    acceptSignatureLoss: options.acceptSignatureLoss === true,
    ...(typeof options.analysisFileKey === 'string' ? { analysisFileKey: options.analysisFileKey } : {}),
    ...(typeof options.signed === 'boolean' ? { signed: options.signed } : {}),
  };
}

/** Portal limits use decimal KB/MB, which is stricter than binary units. */
export function limitBytes(value: Pick<CompressOptionsValue, 'limitValue' | 'limitUnit'>): number {
  return Math.round(value.limitValue * (value.limitUnit === 'MB' ? 1_000_000 : 1_000));
}

export function compressProblem(options: ToolOptions, inputs: File[] = []): string | undefined {
  const value = parseCompressOptions(options);
  if (value.level === 'fit' && (!Number.isFinite(value.limitValue) || limitBytes(value) < 20_000)) {
    return 'Enter a size limit of at least 20 KB.';
  }
  const file = inputs[0];
  if (file && value.analysisFileKey !== fileKey(file)) return 'Checking the file…';
  if (value.signed && !value.acceptSignatureLoss) {
    return 'Tick the box to confirm the digital signature will stop being valid.';
  }
}
