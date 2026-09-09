import { EncryptedPDFError, PDFDocument } from 'pdf-lib';
import { isPdf } from '@/lib/site/pdfFile';
import { isUserFacingError, ToolError } from './errors';

export const PDF_ERRORS = {
  encrypted: 'This PDF has a password. Unlock it first.',
  corrupt: 'This file could not be read. Try Repair PDF.',
  type: 'Choose a PDF file.',
} as const;

function isEncryptedError(error: unknown): boolean {
  // pdf-lib's downlevel Error subclass can lose its prototype in some builds.
  return error instanceof EncryptedPDFError || (error instanceof Error
    && (error.name === 'PasswordException' || error.message === new EncryptedPDFError().message));
}

export function friendlyError(error: unknown): string {
  if (isUserFacingError(error)) return error.message;
  if (error instanceof Error) {
    if (Object.values(PDF_ERRORS).some((message) => message === error.message)) return error.message;
    if (isEncryptedError(error)) return PDF_ERRORS.encrypted;
  }
  return 'Something went wrong. Please try again.';
}

export async function loadPdfLib(file: File): Promise<PDFDocument> {
  if (!isPdf(file)) throw new ToolError(PDF_ERRORS.type);
  try {
    return await PDFDocument.load(await file.arrayBuffer());
  } catch (error) {
    if (isEncryptedError(error)) throw new ToolError(PDF_ERRORS.encrypted);
    throw new ToolError(PDF_ERRORS.corrupt);
  }
}

export async function loadPdfJs(file: File) {
  if (!isPdf(file)) throw new ToolError(PDF_ERRORS.type);
  try {
    const { loadDocument } = await import('@/lib/pdf/loadDocument');
    return await loadDocument(file);
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') throw new ToolError(PDF_ERRORS.encrypted);
    throw new ToolError(PDF_ERRORS.corrupt);
  }
}

// pdf-lib saves asynchronously; callers must await the resulting bytes.
export async function savePdf(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: true });
}

export function safeFilename(name: string): string {
  return Array.from(name.split(/[\\/]/).pop() ?? '', (char) => char.charCodeAt(0) < 32 ? '_' : char)
    .join('').replace(/[<>:"|?*]/g, '_').trim()
    .replace(/^\.+|[. ]+$/g, '') || 'document';
}

export function outputName(file: File | string, slug: string, ext = 'pdf'): string {
  const original = safeFilename(typeof file === 'string' ? file : file.name);
  const stem = original.replace(/\.[^.]+$/, '') || 'document';
  return `${stem}-${safeFilename(slug)}.${ext.replace(/^\./, '').replace(/[^a-z0-9]/gi, '') || 'pdf'}`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.max(0, Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1));
  return `${Number((n / 1024 ** index).toFixed(index === 0 ? 0 : 1))} ${units[index]}`;
}
