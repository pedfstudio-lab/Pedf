import { describe, expect, it, vi } from 'vitest';
import { EncryptedPDFError, PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ToolError } from './errors';
import { formatBytes, friendlyError, loadPdfJs, loadPdfLib, outputName, PDF_ERRORS, savePdf } from './pdfIo';

// Keep pdf.js's real parser but use the Node-compatible worker in these tests.
vi.mock('@/lib/pdf/worker', async () => ({ pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs') }));

async function fixture(): Promise<File> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]).drawText('Local document');
  doc.addPage([500, 600]);
  return new File([(await doc.save()).slice().buffer], 'fixture.pdf', { type: 'application/pdf' });
}

describe('PDF I/O', () => {
  it('loads and saves PDF bytes that reopen with the same pages and text', async () => {
    const file = await fixture();
    const doc = await loadPdfLib(file);
    const bytes = await savePdf(doc);
    const reopened = await getDocument({ data: bytes.slice() }).promise;
    try {
      expect(reopened.numPages).toBe(2);
      const page = await reopened.getPage(1);
      expect(page.getViewport({ scale: 1 }).width).toBe(300);
      expect((await page.getTextContent()).items.map((item) => 'str' in item ? item.str : '').join(' ')).toContain('Local document');
    } finally { await reopened.destroy(); }
  });

  it('loads pdf.js geometry and keeps pristine bytes separate', async () => {
    const file = await fixture();
    const result = await loadPdfJs(file);
    try {
      expect(result.pages).toHaveLength(2);
      expect(result.pages[1]?.heightPt).toBe(600);
      expect(new TextDecoder().decode(result.originalBytes.slice(0, 5))).toBe('%PDF-');
    } finally { await result.doc.destroy(); }
  });

  it('rejects non-PDF inputs before parsing', async () => {
    const file = new File(['hello'], 'text.txt');
    await expect(loadPdfLib(file)).rejects.toThrow(PDF_ERRORS.type);
    await expect(loadPdfJs(file)).rejects.toThrow(PDF_ERRORS.type);
  });

  it('maps malformed PDF bytes to the repair message', async () => {
    const file = new File(['broken'], 'broken.pdf');
    await expect(loadPdfLib(file)).rejects.toThrow(PDF_ERRORS.corrupt);
    await expect(loadPdfJs(file)).rejects.toThrow(PDF_ERRORS.corrupt);
  });

  it('maps the actual pdf-lib encryption exception (whose name is Error)', async () => {
    const encrypted = new EncryptedPDFError();
    const load = vi.spyOn(PDFDocument, 'load').mockRejectedValueOnce(encrypted);
    try {
      await expect(loadPdfLib(new File(['%PDF-'], 'locked.pdf'))).rejects.toThrow(PDF_ERRORS.encrypted);
      expect(friendlyError(encrypted)).toBe(PDF_ERRORS.encrypted);
    } finally { load.mockRestore(); }
  });

  it('never exposes arbitrary internal error details', () => {
    expect(friendlyError(new Error('private stack details'))).toBe('Something went wrong. Please try again.');
    expect(friendlyError(Object.assign(new Error('password'), { name: 'PasswordException' }))).toBe(PDF_ERRORS.encrypted);
  });

  it('shows user-facing ToolError messages word for word', () => {
    expect(friendlyError(new ToolError('Page numbers must be between 1 and 16.'))).toBe('Page numbers must be between 1 and 16.');
    expect(new ToolError('x').name).toBe('ToolError');
  });

  it('names outputs predictably and strips paths', () => {
    expect(outputName('GOA 2026.pdf', 'merged')).toBe('GOA 2026-merged.pdf');
    expect(outputName('photo.jpeg', 'converted', '.pdf')).toBe('photo-converted.pdf');
    expect(outputName('../folder/resume.PDF', 'split', 'jpg')).toBe('resume-split.jpg');
    expect(outputName('file', 'copy')).toBe('file-copy.pdf');
  });

  it.each([[0, '0 B'], [100, '100 B'], [1024, '1 KB'], [1536, '1.5 KB'], [1048576, '1 MB'], [-1, '0 B']])('formats %s bytes', (bytes, expected) => {
    expect(formatBytes(Number(bytes))).toBe(expected);
  });
});
