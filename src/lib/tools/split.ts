import { PDFDocument } from 'pdf-lib';
import { SplitOptions } from '@/components/tools/SplitOptions';
import { ToolError } from './errors';
import { describePageIndices, parsePageRanges } from './pageRanges';
import { loadPdfLib, outputName, savePdf } from './pdfIo';
import { DEFAULT_SPLIT_OPTIONS, type SplitMode, type SplitOptionsValue } from './splitOptions';
import type { ToolContext, ToolDefinition, ToolOptions, ToolOutput } from './types';

export const SPLIT_INPUT_ERROR = 'Choose one PDF file to split.';
export const EVERY_N_ERROR = 'Pages per PDF must be a whole number greater than 0.';

function readOptions(options: ToolOptions): SplitOptionsValue {
  const mode: SplitMode = options.mode === 'every-page' || options.mode === 'every-n' ? options.mode : 'custom';
  return {
    mode,
    ranges: typeof options.ranges === 'string' ? options.ranges : '',
    everyN: typeof options.everyN === 'number' ? options.everyN : Number.NaN,
    mergeRanges: options.mergeRanges === true,
  };
}

export function buildSplitGroups(options: ToolOptions, pageCount: number): number[][] {
  const value = readOptions(options);
  if (value.mode === 'custom') {
    const ranges = parsePageRanges(value.ranges, pageCount);
    return value.mergeRanges ? [ranges.flat()] : ranges;
  }
  if (value.mode === 'every-page') {
    return Array.from({ length: pageCount }, (_, index) => [index]);
  }
  if (!Number.isInteger(value.everyN) || value.everyN < 1) throw new ToolError(EVERY_N_ERROR);
  const groups: number[][] = [];
  for (let start = 0; start < pageCount; start += value.everyN) {
    groups.push(Array.from({ length: Math.min(value.everyN, pageCount - start) }, (_, index) => start + index));
  }
  return groups;
}

function rangeName(file: File, indices: number[]): string {
  if (indices.length === 1) return outputName(file, `page-${indices[0]! + 1}`);
  const descriptions: string[] = [];
  let start = indices[0]!;
  let previous = start;
  for (const index of indices.slice(1)) {
    if (index === previous + 1) {
      previous = index;
      continue;
    }
    descriptions.push(describePageIndices(Array.from({ length: previous - start + 1 }, (_, offset) => start + offset)));
    start = previous = index;
  }
  descriptions.push(describePageIndices(Array.from({ length: previous - start + 1 }, (_, offset) => start + offset)));
  return outputName(file, `pages-${descriptions.join('_')}`);
}

export async function run(inputs: File[], options: ToolOptions, ctx: ToolContext): Promise<ToolOutput[]> {
  const { signal, onProgress } = ctx;
  signal.throwIfAborted();
  if (inputs.length !== 1) throw new ToolError(SPLIT_INPUT_ERROR);
  const file = inputs[0]!;
  const source = await loadPdfLib(file);
  signal.throwIfAborted();
  const groups = buildSplitGroups(options, source.getPageCount());
  const outputs: ToolOutput[] = [];
  for (const [index, indices] of groups.entries()) {
    signal.throwIfAborted();
    onProgress(index, groups.length, `Creating ${rangeName(file, indices)}`);
    const output = await PDFDocument.create();
    const pages = await output.copyPages(source, indices);
    signal.throwIfAborted();
    for (const page of pages) output.addPage(page);
    const bytes = await savePdf(output);
    signal.throwIfAborted();
    outputs.push({ name: rangeName(file, indices), bytes, mime: 'application/pdf' });
    onProgress(index + 1, groups.length, index === groups.length - 1 ? 'Split PDFs ready' : `Created ${rangeName(file, indices)}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  return outputs;
}

export const splitTool: ToolDefinition = {
  slug: 'split', title: 'Split PDF',
  description: 'Extract page ranges or turn each page into a separate PDF.',
  accepts: 'pdf', multiple: false, defaultOptions: DEFAULT_SPLIT_OPTIONS, Options: SplitOptions, icon: '✂', run,
};
