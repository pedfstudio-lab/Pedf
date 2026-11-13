import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { encryptPdfBytes } from '@/lib/lockPdf/engine';
import { decryptPdfBytes } from '@/lib/unlockPdf/engine';
import { loadDocument } from './loadDocument';
import { PdfPasswordError } from './passwordError';
import { unlockPdfBytes, unlockPdfFile, wasUnlocked } from './protection';

const wasm = resolve('node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm');
// Real pdf.js parser with its Node build; the unlock worker runs the real qpdf engine in-process.
vi.mock('@/lib/pdf/worker', async () => ({ pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs') }));
const unlockPdf = vi.hoisted(() => vi.fn());
vi.mock('@/lib/unlockPdf/client', () => ({ unlockPdf }));
unlockPdf.mockImplementation((bytes: Uint8Array, password: string) => decryptPdfBytes(bytes, password, wasm));

async function sample(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([300, 400]).drawText('Salary slip', { x: 30, y: 350, size: 14, font });
  pdf.addPage([500, 600]);
  return pdf.save();
}
const isEncrypted = (bytes: Uint8Array) => /\/Encrypt\s+(?:\d+\s+\d+\s+R|<<)/u.test(new TextDecoder('latin1').decode(bytes));

describe('opening protected PDFs', () => {
  it('leaves ordinary PDFs exactly as they are, without starting the unlock engine', async () => {
    unlockPdf.mockClear();
    const bytes = await sample();
    const result = await unlockPdfBytes(bytes);
    expect(result).toEqual({ bytes, protection: 'none' });
    const loaded = await loadDocument(bytes);
    try {
      expect(loaded.protection).toBe('none');
      expect(loaded.originalBytes).toEqual(bytes);
    } finally { await loaded.doc.destroy(); }
    expect(unlockPdf).not.toHaveBeenCalled();
  }, 30_000);

  it('asks for the password, tells a wrong one apart, and opens with the right one', async () => {
    const locked = await encryptPdfBytes(await sample(), 'Statement 2026', wasm);
    await expect(unlockPdfBytes(locked)).rejects.toMatchObject({ name: 'PdfPasswordError', reason: 'needed' });
    await expect(loadDocument(locked, { password: 'nope' })).rejects.toBeInstanceOf(PdfPasswordError);
    await expect(loadDocument(locked, { password: 'nope' })).rejects.toMatchObject({ reason: 'incorrect' });

    const loaded = await loadDocument(locked, { password: 'Statement 2026' });
    try {
      expect(loaded.protection).toBe('password');
      expect(loaded.pages.map(page => page.heightPt)).toEqual([400, 600]);
      expect(isEncrypted(loaded.originalBytes)).toBe(false);
      await expect(PDFDocument.load(loaded.originalBytes)).resolves.toBeTruthy();
    } finally { await loaded.doc.destroy(); }
  }, 30_000);

  it('unlocks a restricted PDF by itself, so Download works', async () => {
    const restricted = await (async () => {
      const createModule = (await import('@neslinesli93/qpdf-wasm')).default;
      const module = await createModule({ locateFile: () => wasm });
      const fs = module.FS as typeof module.FS & { writeFile(path: string, data: Uint8Array): void };
      fs.writeFile('/in.pdf', await sample());
      module.callMain(['/in.pdf', '--encrypt', '--user-password=', '--owner-password=x', '--bits=256', '--modify=none', '--', '/out.pdf']);
      return Uint8Array.from(fs.readFile('/out.pdf'));
    })();
    const loaded = await loadDocument(restricted);
    try {
      expect(loaded.protection).toBe('restricted');
      await expect(PDFDocument.load(loaded.originalBytes)).resolves.toBeTruthy();
    } finally { await loaded.doc.destroy(); }
  }, 30_000);

  it('gives the tools an unlocked copy with the same name, and remembers it was unlocked', async () => {
    const locked = await encryptPdfBytes(await sample(), 'Statement 2026', wasm);
    const file = new File([locked.slice().buffer], 'statement.pdf', { type: 'application/pdf' });
    await expect(unlockPdfFile(file)).rejects.toMatchObject({ reason: 'needed' });
    const result = await unlockPdfFile(file, 'Statement 2026');
    expect(result.protection).toBe('password');
    expect(result.file.name).toBe('statement.pdf');
    expect(result.file).not.toBe(file);
    expect(wasUnlocked(result.file)).toBe(true);
    expect(wasUnlocked(file)).toBe(false);

    const plain = new File([(await sample()).slice().buffer], 'plain.pdf', { type: 'application/pdf' });
    const same = await unlockPdfFile(plain);
    expect(same).toEqual({ file: plain, protection: 'none' });
    expect(wasUnlocked(plain)).toBe(false);
  }, 30_000);
});
