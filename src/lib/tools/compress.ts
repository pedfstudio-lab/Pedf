import { CompressOptions } from '@/components/tools/CompressOptions';
import { analyzeFile } from '@/lib/compress/analyze';
import { compressPdf, fitUnderSize, type CompressResult } from '@/lib/compress/compressPdf';
import { estimateAllLevels, estimateFileLevels } from '@/lib/compress/estimate';
import { ToolError } from './errors';
import { fileKey } from './organizePlan';
import { formatBytes, outputName } from './pdfIo';
import {
  compressProblem,
  DEFAULT_COMPRESS_OPTIONS,
  limitBytes,
  parseCompressOptions,
} from './compressOptions';
import type { ToolContext, ToolDefinition, ToolOptions, ToolOutput } from './types';

export const COMPRESS_INPUT_ERROR = 'Choose one PDF file to compress.';
export const COMPRESS_SIGNATURE_WARNING = 'The digital signature is no longer valid in the compressed copy.';

function resultSummary(originalBytes: number, result: CompressResult): string {
  const percent = originalBytes > 0 ? Math.max(0, Math.round((1 - result.bytes.byteLength / originalBytes) * 100)) : 0;
  const made = `${result.madeSmaller} ${result.madeSmaller === 1 ? 'photo' : 'photos'} made smaller`;
  const left = `${result.leftAsTheyWere} left as ${result.leftAsTheyWere === 1 ? 'it was' : 'they were'}`;
  const removed = result.removedUnused > 0
    ? ` ${result.removedUnused} unused ${result.removedUnused === 1 ? 'photo' : 'photos'} removed.` : '';
  return `${formatBytes(originalBytes)} → ${formatBytes(result.bytes.byteLength)} (${percent}% smaller). ${made}, ${left}.${removed}`;
}

function outputNote(originalBytes: number, result: CompressResult, signatureInvalid: boolean): NonNullable<ToolOutput['note']> {
  const changed = result.bytes.byteLength !== originalBytes;
  const parts = changed ? [resultSummary(originalBytes, result)] : [];
  if (result.note?.text) parts.push(result.note.text);
  if (signatureInvalid) parts.push(COMPRESS_SIGNATURE_WARNING);
  return {
    text: parts.join(' '),
    tone: signatureInvalid || result.note?.tone === 'warn' ? 'warn' : result.note?.tone ?? 'ok',
  };
}

export async function run(inputs: File[], options: ToolOptions, ctx: ToolContext): Promise<ToolOutput[]> {
  const { signal, onProgress } = ctx;
  signal.throwIfAborted();
  if (inputs.length !== 1) throw new ToolError(COMPRESS_INPUT_ERROR);
  const file = inputs[0]!;
  const value = parseCompressOptions(options);
  const optionProblem = compressProblem(value);
  if (optionProblem) throw new ToolError(optionProblem);

  const analysis = await analyzeFile(file, signal);
  const checked = { ...value, analysisFileKey: fileKey(file), signed: analysis.signed };
  const problem = compressProblem(checked, [file]);
  if (problem) throw new ToolError(problem);
  signal.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();

  let estimates;
  try { estimates = await estimateFileLevels(file, analysis, signal); }
  catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    estimates = estimateAllLevels(analysis);
  }
  let result: CompressResult;
  if (checked.level === 'fit') {
    result = await fitUnderSize(bytes, limitBytes(checked), { signal, onProgress, analysis, estimates });
  } else {
    result = await compressPdf(bytes, checked.level, { signal, onProgress, analysis, estimates });
  }
  signal.throwIfAborted();
  const signatureInvalid = analysis.signed && result.bytes.byteLength !== bytes.byteLength;
  if (signatureInvalid) ctx.onWarning?.(COMPRESS_SIGNATURE_WARNING);
  onProgress(1, 1, 'Compressed PDF ready');
  return [{
    name: outputName(file, 'compressed'),
    bytes: result.bytes,
    mime: 'application/pdf',
    note: outputNote(bytes.byteLength, result, signatureInvalid),
  }];
}

export const compressTool: ToolDefinition = {
  slug: 'compress',
  title: 'Compress PDF',
  description: 'Make a PDF smaller by shrinking the photos inside. Text stays sharp.',
  accepts: 'pdf',
  multiple: false,
  defaultOptions: DEFAULT_COMPRESS_OPTIONS,
  Options: CompressOptions,
  icon: '🗜',
  canRun: (options, inputs) => compressProblem(options, inputs),
  run,
};
