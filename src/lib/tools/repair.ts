import { PDFDocument, type PDFPage } from 'pdf-lib';
import { RepairOptions } from '@/components/tools/RepairOptions';
import { pdfjs } from '@/lib/pdf/worker';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { ToolError } from './errors';
import { fileKey } from './organizePlan';
import { describePageIndices } from './pageRanges';
import { outputName, savePdf } from './pdfIo';
import { renderPageImage } from './pdfToJpg';
import { inspectPdf, type Inspection } from './repairInspect';
import { rescuePageList } from './repairRescue';
import { DEFAULT_REPAIR_OPTIONS, parseRepairOptions, repairProblem } from './repairOptions';
import type { ToolContext, ToolDefinition, ToolOutput } from './types';

export const REPAIR_INPUT_ERROR = 'Choose one PDF file to repair.';
export const TOO_DAMAGED_ERROR = 'This file is too damaged to repair.';
export const SIGNATURE_WARNING = 'The digital signature is not valid in the repaired copy.';

export interface Verification { ok: boolean; pageCount: number; badPages: number[] }
export interface RepairAttempt {
  bytes: Uint8Array;
  promisedPageCount: number;
  note: NonNullable<ToolOutput['note']>;
}
export type RepairTry = (ctx: ToolContext) => Promise<RepairAttempt | undefined>;
export type RepairVerifier = (bytes: Uint8Array, ctx?: ToolContext) => Promise<Verification>;

async function yieldToUi(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function openPdfJs(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ data: bytes.slice() }).promise;
}

export async function verifyPdf(bytes: Uint8Array, ctx?: ToolContext): Promise<Verification> {
  ctx?.signal.throwIfAborted();
  let libraryCount = -1;
  try {
    const document = await PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false });
    libraryCount = document.getPageCount();
  } catch {
    return { ok: false, pageCount: 0, badPages: [] };
  }

  let document: PDFDocumentProxy;
  try {
    document = await openPdfJs(bytes);
  } catch {
    return { ok: false, pageCount: libraryCount, badPages: [] };
  }
  const badPages: number[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      ctx?.signal.throwIfAborted();
      try {
        const page = await document.getPage(pageNumber);
        await page.getOperatorList();
        page.cleanup();
      } catch {
        badPages.push(pageNumber - 1);
      }
      if (pageNumber % 10 === 0) await yieldToUi();
    }
    return {
      ok: libraryCount === document.numPages && badPages.length === 0,
      pageCount: document.numPages,
      badPages,
    };
  } finally {
    await document.destroy();
  }
}

export async function repairLadder(
  tries: readonly RepairTry[],
  verify: RepairVerifier,
  ctx: ToolContext,
): Promise<RepairAttempt> {
  for (const attempt of tries) {
    ctx.signal.throwIfAborted();
    try {
      const result = await attempt(ctx);
      if (!result) continue;
      ctx.signal.throwIfAborted();
      ctx.onProgress(0, 1, 'Checking the repaired file…');
      const checked = await verify(result.bytes, ctx);
      if (checked.ok && checked.pageCount === result.promisedPageCount && checked.badPages.length === 0) return result;
    } catch (error) {
      if (ctx.signal.aborted || isAbort(error)) throw error;
    }
  }
  throw new ToolError(TOO_DAMAGED_ERROR);
}

function pageGroups(indices: number[]): string {
  const groups: number[][] = [];
  for (const index of indices) {
    const current = groups.at(-1);
    if (current && current.at(-1) === index - 1) current.push(index);
    else groups.push([index]);
  }
  return groups.map(describePageIndices).join(', ');
}

function rebuildNote(total: number, kept: number[], imaged: number[], lost: number[]): string {
  const parts = [`Rebuilt page by page. ${kept.length} of ${total} pages kept as they were.`];
  if (imaged.length === 1) parts.push(`Page ${pageGroups(imaged)} became an image.`);
  else if (imaged.length > 1) parts.push(`Pages ${pageGroups(imaged)} became images.`);
  if (lost.length === 1) parts.push(`Page ${pageGroups(lost)} could not be read.`);
  else if (lost.length > 1) parts.push(`Pages ${pageGroups(lost)} could not be read.`);
  return parts.join(' ');
}

async function addImagePage(
  output: PDFDocument,
  page: PDFPageProxy,
  pageIndex: number,
  pageCount: number,
  ctx: ToolContext,
): Promise<PDFPage> {
  ctx.signal.throwIfAborted();
  ctx.onProgress(pageIndex, pageCount, `Turning page ${pageIndex + 1} into an image…`);
  const viewport = page.getViewport({ scale: 1 });
  const rendered = await renderPageImage(page, 150, 'jpg', ctx.signal, 0.85);
  const image = await output.embedJpg(rendered.bytes);
  const outputPage = output.addPage([viewport.width, viewport.height]);
  outputPage.drawImage(image, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  return outputPage;
}

interface MixedResult extends RepairAttempt {
  originalPages: number[];
  kept: number[];
  imaged: number[];
  lost: number[];
}

async function assembleMixed(
  source: PDFDocument,
  reader: PDFDocumentProxy,
  copyable: number[],
  forceImage: Set<number>,
  ctx: ToolContext,
  prepared?: { output: PDFDocument; copied: PDFPage[] },
): Promise<MixedResult | undefined> {
  const total = reader.numPages;
  const copiedIndices = copyable.filter((index) => !forceImage.has(index));
  const output = prepared?.output ?? await PDFDocument.create();
  const copied = prepared?.copied ?? (copiedIndices.length ? await output.copyPages(source, copiedIndices) : []);
  const copiedByIndex = new Map(copiedIndices.map((index, position) => [index, copied[position]!]));
  const kept: number[] = [];
  const imaged: number[] = [];
  const lost: number[] = [];
  const originalPages: number[] = [];

  for (let index = 0; index < total; index += 1) {
    ctx.signal.throwIfAborted();
    ctx.onProgress(index, total, `Rebuilding page ${index + 1} of ${total}…`);
    const copiedPage = copiedByIndex.get(index);
    if (copiedPage) {
      output.addPage(copiedPage);
      kept.push(index);
      originalPages.push(index);
    } else {
      try {
        const page = await reader.getPage(index + 1);
        await addImagePage(output, page, index, total, ctx);
        imaged.push(index);
        originalPages.push(index);
      } catch (error) {
        if (ctx.signal.aborted || isAbort(error)) throw error;
        lost.push(index);
      }
    }
    if ((index + 1) % 10 === 0) await yieldToUi();
  }

  if (!originalPages.length) return undefined;
  const bytes = await savePdf(output);
  return {
    bytes,
    promisedPageCount: originalPages.length,
    originalPages,
    kept,
    imaged,
    lost,
    note: { text: rebuildNote(total, kept, imaged, lost), tone: 'warn' },
  };
}

export async function tryRewriteIndex(
  bytes: Uint8Array,
  _inspection: Inspection,
  ctx: ToolContext,
): Promise<RepairAttempt | undefined> {
  ctx.signal.throwIfAborted();
  ctx.onProgress(0, 1, "Rebuilding the file's index…");
  try {
    const document = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
    const pageCount = document.getPageCount();
    if (!pageCount) return undefined;
    const repaired = await savePdf(document);
    return {
      bytes: repaired,
      promisedPageCount: pageCount,
      note: { text: `Rebuilt the file's index. All ${pageCount} pages kept. Nothing else changed.`, tone: 'ok' },
    };
  } catch (error) {
    if (ctx.signal.aborted || isAbort(error)) throw error;
    return undefined;
  }
}

export async function tryRebuildPages(
  bytes: Uint8Array,
  _inspection: Inspection,
  ctx: ToolContext,
): Promise<RepairAttempt | undefined> {
  let source: PDFDocument;
  let reader: PDFDocumentProxy;
  try {
    source = await PDFDocument.load(bytes, { throwOnInvalidObject: false, updateMetadata: false });
    reader = await openPdfJs(bytes);
  } catch (error) {
    if (ctx.signal.aborted || isAbort(error)) throw error;
    return undefined;
  }

  try {
    const all = Array.from({ length: reader.numPages }, (_, index) => index);
    let copyable = all;
    let prepared: { output: PDFDocument; copied: PDFPage[] } | undefined;
    const firstOutput = await PDFDocument.create();
    try {
      prepared = { output: firstOutput, copied: await firstOutput.copyPages(source, all) };
    } catch {
      copyable = [];
      for (const index of all) {
        ctx.signal.throwIfAborted();
        try {
          const probe = await PDFDocument.create();
          await probe.copyPages(source, [index]);
          copyable.push(index);
        } catch {
          // A reader-renderable page will be preserved as an image below.
        }
      }
    }

    let result = await assembleMixed(source, reader, copyable, new Set(), ctx, prepared);
    if (!result) return undefined;
    const checked = await verifyPdf(result.bytes, ctx);
    if (checked.badPages.length) {
      const forceImage = new Set(checked.badPages.map((index) => result!.originalPages[index]).filter(
        (index): index is number => index !== undefined,
      ));
      result = await assembleMixed(source, reader, copyable, forceImage, ctx);
    }
    return result;
  } finally {
    await reader.destroy();
  }
}

/**
 * Try 3 — the page list is gone (e.g. a download that stopped): find the pages still in the file, give them a
 * fresh page list, then clean the result with the normal tries. Only runs when neither reader can open the file.
 */
export async function tryRescuePages(
  bytes: Uint8Array,
  inspection: Inspection,
  ctx: ToolContext,
): Promise<RepairAttempt | undefined> {
  ctx.signal.throwIfAborted();
  ctx.onProgress(0, 1, 'Searching the file for pages…');
  let rescued: Awaited<ReturnType<typeof rescuePageList>>;
  try {
    rescued = await rescuePageList(bytes);
  } catch (error) {
    if (ctx.signal.aborted || isAbort(error)) throw error;
    return undefined;
  }
  if (!rescued) return undefined;
  ctx.signal.throwIfAborted();

  const { pageCount, incompletePages } = rescued;
  const found = `The file's page list was missing, so we searched the file and found ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}.`;
  const partial = incompletePages.length === 1
    ? ` Page ${pageGroups(incompletePages)} is missing some parts.`
    : incompletePages.length > 1 ? ` Pages ${pageGroups(incompletePages)} are missing some parts.` : '';
  const cutShort = ' If the file was cut short, the pages after these are missing.';

  const rewritten = await tryRewriteIndex(rescued.bytes, inspection, ctx);
  if (rewritten) {
    const checked = await verifyPdf(rewritten.bytes, ctx);
    if (checked.ok && checked.pageCount === rewritten.promisedPageCount) {
      return {
        ...rewritten,
        note: { text: `${found} All ${pageCount} were rebuilt.${partial}${cutShort}`, tone: 'warn' },
      };
    }
  }
  const rebuilt = await tryRebuildPages(rescued.bytes, inspection, ctx);
  if (rebuilt) return { ...rebuilt, note: { text: `${found} ${rebuilt.note.text}${partial}${cutShort}`, tone: 'warn' } };
  const pictures = await tryPictures(rescued.bytes, inspection, ctx);
  if (pictures) return { ...pictures, note: { text: `${found} ${pictures.note.text}${cutShort}`, tone: 'danger' } };
  return undefined;
}

export async function tryPictures(
  bytes: Uint8Array,
  _inspection: Inspection,
  ctx: ToolContext,
): Promise<RepairAttempt | undefined> {
  let reader: PDFDocumentProxy;
  try {
    reader = await openPdfJs(bytes);
  } catch (error) {
    if (ctx.signal.aborted || isAbort(error)) throw error;
    return undefined;
  }

  try {
    const output = await PDFDocument.create();
    const lost: number[] = [];
    let kept = 0;
    for (let index = 0; index < reader.numPages; index += 1) {
      ctx.signal.throwIfAborted();
      try {
        const page = await reader.getPage(index + 1);
        await addImagePage(output, page, index, reader.numPages, ctx);
        kept += 1;
      } catch (error) {
        if (ctx.signal.aborted || isAbort(error)) throw error;
        lost.push(index);
      }
      if ((index + 1) % 10 === 0) await yieldToUi();
    }
    if (!kept) return undefined;
    const suffix = lost.length
      ? ` ${lost.length === 1 ? 'Page' : 'Pages'} ${pageGroups(lost)} could not be read.`
      : '';
    return {
      bytes: await savePdf(output),
      promisedPageCount: kept,
      note: {
        text: `Text became images: every page is now a picture. It opens everywhere, but text can't be selected, searched, edited or read aloud.${suffix}`,
        tone: 'danger',
      },
    };
  } finally {
    await reader.destroy();
  }
}

export async function run(inputs: File[], options: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput[]> {
  ctx.signal.throwIfAborted();
  if (inputs.length !== 1) throw new ToolError(REPAIR_INPUT_ERROR);
  const file = inputs[0]!;
  ctx.onProgress(0, 1, 'Checking the file…');
  const bytes = new Uint8Array(await file.arrayBuffer());
  ctx.signal.throwIfAborted();
  const inspection = await inspectPdf(bytes, (done, total) => {
    ctx.onProgress(done, total, total > 0 ? `Checking page ${done} of ${total}…` : 'Checking the file…');
  }, ctx.signal);
  const value = parseRepairOptions(options);
  const checkedOptions = { ...value, inspection: { ...inspection, fileKey: fileKey(file) } };
  const problem = repairProblem(checkedOptions, [file]);
  if (problem) throw new ToolError(problem);
  if ('signed' in inspection && inspection.signed) ctx.onWarning?.(SIGNATURE_WARNING);

  const result = await repairLadder([
    (attemptContext) => tryRewriteIndex(bytes, inspection, attemptContext),
    (attemptContext) => tryRebuildPages(bytes, inspection, attemptContext),
    (attemptContext) => tryRescuePages(bytes, inspection, attemptContext),
    (attemptContext) => tryPictures(bytes, inspection, attemptContext),
  ], verifyPdf, ctx);
  ctx.onProgress(1, 1, 'Repaired PDF ready');
  return [{ name: outputName(file, 'repaired'), bytes: result.bytes, mime: 'application/pdf', note: result.note }];
}

export const repairTool: ToolDefinition = {
  slug: 'repair',
  title: 'Repair PDF',
  description: "Fix PDFs that won't open or open with errors — see exactly what was kept.",
  accepts: 'pdf',
  multiple: false,
  defaultOptions: DEFAULT_REPAIR_OPTIONS,
  Options: RepairOptions,
  icon: '✚',
  previewFailureText: 'No preview. See the file check below.',
  canRun: (options, inputs) => repairProblem(options, inputs),
  run,
};
