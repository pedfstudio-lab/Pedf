import { degrees, PDFDocument, PDFName } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import { OrganizeOptions } from '@/components/tools/OrganizeOptions';
import { ToolError } from './errors';
import { parseOrganizeOptions, DEFAULT_ORGANIZE_OPTIONS } from './organizeOptions';
import { fileKey, isIdentityPlan, knownPageCount, type OrganizeFileInfo, type OrganizePlan } from './organizePlan';
import { loadPdfLib, outputName, savePdf } from './pdfIo';
import { nextRotation } from './rotateOptions';
import type { ToolContext, ToolDefinition, ToolOptions, ToolOutput } from './types';

export const EMPTY_PLAN_ERROR = 'Keep at least one page.';
export const NO_CHANGE_ERROR = 'Move, rotate, delete, or add a page first.';
export const MISSING_FILE_ERROR = 'A file used by the plan was removed. Press Reset and try again.';
export const FORMS_WARNING = 'Form fields are not carried over to the organized file.';

function missingSource(plan: OrganizePlan, inputs: File[]): boolean {
  const keys = new Set(inputs.map(fileKey));
  return plan.some((entry) => entry.kind === 'page' && !keys.has(entry.fileKey));
}

function inferredFiles(plan: OrganizePlan, inputs: File[]): OrganizeFileInfo[] {
  return inputs.map((file) => {
    const key = fileKey(file);
    const indices = plan.flatMap((entry) => entry.kind === 'page' && entry.fileKey === key ? [entry.pageIndex] : []);
    return { key, pageCount: knownPageCount(file) ?? (indices.length ? Math.max(...indices) + 1 : 0) };
  });
}

export function canRun(options: ToolOptions, inputs: File[]): string | undefined {
  const { plan } = parseOrganizeOptions(options);
  if (!plan.length) return EMPTY_PLAN_ERROR;
  if (missingSource(plan, inputs)) return MISSING_FILE_ERROR;
  const files = inferredFiles(plan, inputs);
  if (files.every(({ pageCount }) => pageCount > 0) && isIdentityPlan(plan, files)) return NO_CHANGE_ERROR;
  return undefined;
}

function assertPlanFiles(plan: OrganizePlan, inputs: File[]): void {
  if (!plan.length) throw new ToolError(EMPTY_PLAN_ERROR);
  if (!inputs.length) throw new ToolError(MISSING_FILE_ERROR);
  if (missingSource(plan, inputs)) throw new ToolError(MISSING_FILE_ERROR);
}

export async function run(inputs: File[], options: ToolOptions, ctx: ToolContext): Promise<ToolOutput[]> {
  const { signal, onProgress, onWarning } = ctx;
  signal.throwIfAborted();
  const { plan } = parseOrganizeOptions(options);
  assertPlanFiles(plan, inputs);

  const inputByKey = new Map(inputs.map((file) => [fileKey(file), file]));
  const referencedKeys = new Set(plan.flatMap((entry) => entry.kind === 'page' ? [entry.fileKey] : []));
  const sources = new Map<string, PDFDocument>();
  const sourceInfo: OrganizeFileInfo[] = [];
  let warnedForForms = false;

  for (const file of inputs) {
    const key = fileKey(file);
    if (!referencedKeys.has(key) || sources.has(key)) continue;
    signal.throwIfAborted();
    const source = await loadPdfLib(file);
    signal.throwIfAborted();
    sources.set(key, source);
    sourceInfo.push({ key, pageCount: source.getPageCount() });
    if (!warnedForForms && source.catalog.has(PDFName.of('AcroForm'))) {
      warnedForForms = true;
      onWarning?.(FORMS_WARNING);
    }
  }

  if (referencedKeys.size === inputByKey.size && isIdentityPlan(plan, sourceInfo)) {
    throw new ToolError(NO_CHANGE_ERROR);
  }
  for (const entry of plan) {
    if (entry.kind !== 'page') continue;
    const source = sources.get(entry.fileKey);
    if (!source || entry.pageIndex >= source.getPageCount()) throw new ToolError(MISSING_FILE_ERROR);
  }

  const output = await PDFDocument.create();

  // Copy every page a source contributes in ONE copyPages call, in plan order and with repeats for
  // duplicates. Each call starts a fresh object copier, so copying page by page would re-copy the
  // fonts and images shared between pages — an 84-page text document grew from 2.9 MB to 28 MB.
  const requested = new Map<string, number[]>();
  for (const entry of plan) {
    if (entry.kind !== 'page') continue;
    const indices = requested.get(entry.fileKey) ?? [];
    indices.push(entry.pageIndex);
    requested.set(entry.fileKey, indices);
  }
  const copies = new Map<string, PDFPage[]>();
  for (const [key, indices] of requested) {
    signal.throwIfAborted();
    onProgress(0, plan.length, `Copying ${indices.length} ${indices.length === 1 ? 'page' : 'pages'} from ${inputByKey.get(key)?.name ?? 'the PDF'}`);
    copies.set(key, await output.copyPages(sources.get(key)!, indices));
  }

  const taken = new Map<string, number>();
  for (const [index, entry] of plan.entries()) {
    signal.throwIfAborted();
    onProgress(index, plan.length, `Adding page ${index + 1} of ${plan.length}`);
    if (entry.kind === 'blank') {
      output.addPage([entry.widthPt, entry.heightPt]);
    } else {
      const position = taken.get(entry.fileKey) ?? 0;
      taken.set(entry.fileKey, position + 1);
      const copied = copies.get(entry.fileKey)?.[position];
      if (!copied) throw new ToolError(MISSING_FILE_ERROR);
      copied.setRotation(degrees(nextRotation(copied.getRotation().angle, entry.turns * 90)));
      output.addPage(copied);
    }
    if ((index + 1) % 20 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  signal.throwIfAborted();
  const bytes = await savePdf(output);
  signal.throwIfAborted();
  onProgress(plan.length, plan.length, 'Organized PDF ready');
  return [{ name: outputName(inputs[0]!, 'organized'), bytes, mime: 'application/pdf' }];
}

export const organizeTool: ToolDefinition = {
  slug: 'organize', title: 'Organize PDF',
  description: 'Reorder, rotate, delete, duplicate, and add pages — from one PDF or several.',
  accepts: 'pdf', multiple: true, minInputs: 1, defaultOptions: DEFAULT_ORGANIZE_OPTIONS,
  Options: OrganizeOptions, icon: '⋮⋮', canRun, run,
};
