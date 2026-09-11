import { degrees, rgb, StandardFonts, type PDFDocument, type PDFImage, type PDFPage } from 'pdf-lib';
import { SignOptions } from '@/components/tools/SignOptions';
import { readerAngleToRaw, readerFrame, readerToRaw } from '@/lib/pdf/readerFrame';
import { ToolError } from './errors';
import { loadPdfLib, outputName, savePdf } from './pdfIo';
import { selectedPageIndices } from './pdfToJpgOptions';
import {
  DEFAULT_SIGN_OPTIONS,
  formatSignDate,
  parseSignOptions,
  signatureRect,
  signProblem,
  type SignOptionsValue,
} from './signOptions';
import type { ToolContext, ToolDefinition, ToolOptions, ToolOutput } from './types';

export const SIGN_INPUT_ERROR = 'Choose one PDF file to sign.';

function selectedPages(value: SignOptionsValue, pageCount: number): number[] {
  if (value.pageSelection === 'one') return [Math.min(value.pageIndex, Math.max(0, pageCount - 1))];
  return selectedPageIndices({
    pageSelection: value.pageSelection === 'custom' ? 'custom' : 'all',
    ranges: value.ranges,
  }, pageCount);
}

export interface SignPageGeometry {
  readerRect: ReturnType<typeof signatureRect>;
  pageWidth: number;
  pageHeight: number;
}

/** Draw a prepared signature onto one page at the reader-facing position chosen by the user. */
export function signPage(
  page: PDFPage,
  image: PDFImage,
  value: SignOptionsValue,
  dateText: string,
  dateFont?: Awaited<ReturnType<PDFDocument['embedFont']>>,
): SignPageGeometry {
  const frame = readerFrame(page);
  const rect = signatureRect(frame.width, frame.height, value, image.width / image.height);
  const raw = readerToRaw(frame, rect.u, rect.v);
  const rotation = degrees(readerAngleToRaw(frame, 0));
  page.drawImage(image, {
    x: raw.x,
    y: raw.y,
    width: rect.width,
    height: rect.height,
    rotate: rotation,
  });
  if (dateText && dateFont) {
    const dateBaseline = Math.max(1, rect.v - 13);
    const dateRaw = readerToRaw(frame, rect.u, dateBaseline);
    page.drawText(dateText, {
      x: dateRaw.x,
      y: dateRaw.y,
      size: 9,
      font: dateFont,
      color: rgb(0.25, 0.28, 0.32),
      rotate: rotation,
    });
  }
  return { readerRect: rect, pageWidth: frame.width, pageHeight: frame.height };
}

export async function run(inputs: File[], options: ToolOptions, ctx: ToolContext): Promise<ToolOutput[]> {
  const { signal, onProgress } = ctx;
  signal.throwIfAborted();
  if (inputs.length !== 1) throw new ToolError(SIGN_INPUT_ERROR);
  const problem = signProblem(options);
  if (problem) throw new ToolError(problem);
  const file = inputs[0]!;
  const value = parseSignOptions(options);
  const signature = value.signature!;
  const doc = await loadPdfLib(file);
  signal.throwIfAborted();
  const pages = selectedPages(value, doc.getPageCount());
  const image = await doc.embedPng(signature.png);
  const dateText = formatSignDate(value.date);
  const dateFont = dateText ? await doc.embedFont(StandardFonts.Helvetica) : undefined;

  for (const [index, pageIndex] of pages.entries()) {
    signal.throwIfAborted();
    onProgress(index, pages.length, `Signing page ${index + 1} of ${pages.length}`);
    signPage(doc.getPage(pageIndex), image, value, dateText, dateFont);
    if ((index + 1) % 20 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  const bytes = await savePdf(doc);
  signal.throwIfAborted();
  onProgress(pages.length, pages.length, 'Signed PDF ready');
  return [{ name: outputName(file, 'signed'), bytes, mime: 'application/pdf' }];
}

export const signTool: ToolDefinition = {
  slug: 'sign',
  title: 'Sign PDF',
  description: 'Draw, type or upload your signature and place it exactly where it goes.',
  accepts: 'pdf',
  multiple: false,
  defaultOptions: DEFAULT_SIGN_OPTIONS,
  canRun: (options) => signProblem(options),
  Options: SignOptions,
  icon: '✍',
  run,
};
