import { EncryptedPDFError, PDFDocument } from 'pdf-lib';
import { pdfjs } from '@/lib/pdf/worker';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { describePageIndices } from './pageRanges';

export type Inspection =
  | { kind: 'not-pdf' }
  | { kind: 'locked' }
  | { kind: 'healthy'; pageCount: number; signed: boolean }
  | { kind: 'damaged'; pageCount?: number; badPages: number[]; problems: string[]; signed: boolean };

export type InspectionProgress = (done: number, total: number) => void;

function containsAscii(bytes: Uint8Array, text: string, limit = bytes.length): boolean {
  const needle = Array.from(text, (character) => character.charCodeAt(0));
  const end = Math.min(bytes.length, limit) - needle.length;
  outer: for (let index = 0; index <= end; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

export function hasDigitalSignature(bytes: Uint8Array): boolean {
  return containsAscii(bytes, '/ByteRange') && containsAscii(bytes, '/Sig');
}

function hasCompleteTail(bytes: Uint8Array): boolean {
  const start = Math.max(0, bytes.length - 8192);
  const tail = bytes.subarray(start);
  return containsAscii(tail, 'startxref') && containsAscii(tail, '%%EOF');
}

function isLockedError(error: unknown): boolean {
  return error instanceof EncryptedPDFError || (error instanceof Error
    && (error.name === 'PasswordException' || error.message === new EncryptedPDFError().message));
}

function pageList(indices: number[]): string {
  if (!indices.length) return '';
  const groups: number[][] = [];
  for (const index of indices) {
    const current = groups.at(-1);
    if (current && current.at(-1) === index - 1) current.push(index);
    else groups.push([index]);
  }
  return groups.map(describePageIndices).join(', ');
}

function unreadableProblem(badPages: number[]): string {
  const noun = badPages.length === 1 ? 'page' : 'pages';
  return `${badPages.length} ${noun} can't be read (${noun} ${pageList(badPages)})`;
}

async function yieldToUi(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Inspect with two independent parsers. This never modifies the supplied bytes. */
export async function inspectPdf(
  bytes: Uint8Array,
  onProgress?: InspectionProgress,
  signal?: AbortSignal,
): Promise<Inspection> {
  signal?.throwIfAborted();
  if (!containsAscii(bytes.subarray(0, 1024), '%PDF-')) return { kind: 'not-pdf' };

  const signed = hasDigitalSignature(bytes);
  let libraryCount: number | undefined;
  let libraryFailed = !hasCompleteTail(bytes);
  try {
    const document = await PDFDocument.load(bytes, {
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    libraryCount = document.getPageCount();
  } catch (error) {
    if (isLockedError(error)) return { kind: 'locked' };
    libraryFailed = true;
  }

  signal?.throwIfAborted();
  let document: PDFDocumentProxy;
  try {
    document = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  } catch (error) {
    if (isLockedError(error)) return { kind: 'locked' };
    const problems = libraryFailed ? ["the file's index is broken", 'the page list is broken'] : ['the page list is broken'];
    return { kind: 'damaged', badPages: [], problems, signed };
  }

  const pageCount = document.numPages;
  const badPages: number[] = [];
  try {
    onProgress?.(0, pageCount);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      signal?.throwIfAborted();
      try {
        const page = await document.getPage(pageNumber);
        await page.getOperatorList();
        page.cleanup();
      } catch {
        badPages.push(pageNumber - 1);
      }
      onProgress?.(pageNumber, pageCount);
      if (pageNumber % 10 === 0) await yieldToUi();
    }
  } finally {
    await document.destroy();
  }

  const countsDisagree = libraryCount !== undefined && libraryCount !== pageCount;
  if (!libraryFailed && !countsDisagree && badPages.length === 0) {
    return { kind: 'healthy', pageCount, signed };
  }

  const problems: string[] = [];
  if (libraryFailed) problems.push("the file's index is broken");
  if (countsDisagree) problems.push('the page list is broken');
  if (badPages.length) problems.push(unreadableProblem(badPages));
  if (!problems.length) problems.push('the page list is broken');
  return { kind: 'damaged', pageCount, badPages, problems, signed };
}
