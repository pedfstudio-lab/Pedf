import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import createModule from '@neslinesli93/qpdf-wasm';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { encryptPdfBytes } from '@/lib/lockPdf/engine';
import { decryptPdfBytes } from './engine';

const wasm = resolve('node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm');

async function sample(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([420, 595]).drawText('Account statement - sample', { x: 35, y: 540, size: 16, font });
  pdf.addPage([420, 595]).drawText('Second page', { x: 35, y: 540, size: 12, font });
  return pdf.save();
}

/** The same locks real files use: modern AES-256, older RC4 (many bank statements), and restrictions-only. */
async function protect(bytes: Uint8Array, encrypt: string[], before: string[] = []): Promise<Uint8Array> {
  const module = await createModule({ locateFile: () => wasm });
  const fs = module.FS as typeof module.FS & { writeFile(path: string, data: Uint8Array): void };
  fs.writeFile('/in.pdf', bytes);
  expect(module.callMain([...before, '/in.pdf', '--encrypt', ...encrypt, '--', '/out.pdf'])).toBe(0);
  return Uint8Array.from(fs.readFile('/out.pdf'));
}

async function text(bytes: Uint8Array, password?: string): Promise<string[]> {
  const task = getDocument({ data: bytes.slice(), password, verbosity: 0 });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const content = await (await pdf.getPage(number)).getTextContent();
      pages.push(content.items.map(item => 'str' in item ? item.str : '').join(''));
    }
    return pages;
  } finally { await task.destroy(); }
}

const isEncrypted = (bytes: Uint8Array) => /\/Encrypt\s+(?:\d+\s+\d+\s+R|<<)/u.test(new TextDecoder('latin1').decode(bytes));

describe('unlocking PDFs on the device', () => {
  it.each([
    ['AES-256 (e-Aadhaar style)', ['--user-password=RAHU1990', '--owner-password=owner-secret', '--bits=256'], []],
    ['RC4 128-bit (older bank statements)', ['--user-password=RAHU1990', '--owner-password=owner-secret', '--bits=128', '--use-aes=n'], ['--allow-weak-crypto']],
  ])('opens %s with the right password into an ordinary PDF that pdf-lib can save', async (_label, encrypt, before) => {
    const original = await sample();
    const locked = await protect(original, encrypt, before);
    const unlocked = await decryptPdfBytes(locked, 'RAHU1990', wasm);
    expect(isEncrypted(unlocked)).toBe(false);
    expect(await text(unlocked)).toEqual(await text(original));
    // The export step uses pdf-lib, which refuses protected files: this is what used to break Download.
    await expect(PDFDocument.load(unlocked)).resolves.toBeTruthy();
    await expect(PDFDocument.load(locked)).rejects.toThrow(/encrypted/i);
  }, 30_000);

  it('refuses a wrong password', async () => {
    const locked = await protect(await sample(), ['--user-password=RAHU1990', '--owner-password=owner-secret', '--bits=256']);
    await expect(decryptPdfBytes(locked, 'wrong', wasm)).rejects.toMatchObject({ code: 'password' });
  }, 30_000);

  it('removes editing restrictions from a PDF that opens without a password', async () => {
    const restricted = await protect(await sample(), ['--user-password=', '--owner-password=owner-secret', '--bits=256', '--modify=none', '--print=none']);
    const unlocked = await decryptPdfBytes(restricted, '', wasm);
    expect(isEncrypted(unlocked)).toBe(false);
    await expect(PDFDocument.load(unlocked)).resolves.toBeTruthy();
  }, 30_000);

  it('treats a password that looks like a command as an ordinary password', async () => {
    const password = '--show-encryption-key';
    const locked = await encryptPdfBytes(await sample(), password, wasm);
    const unlocked = await decryptPdfBytes(locked, password, wasm);
    expect((await text(unlocked))[0]).toContain('Account statement');
  }, 30_000);

  it('can put a short existing password (a 4-digit bank PIN) back after editing', async () => {
    const original = await sample();
    await expect(encryptPdfBytes(original, '1234', wasm)).rejects.toMatchObject({ code: 'password' });
    const relocked = await encryptPdfBytes(original, '1234', wasm, undefined, { existingPassword: true });
    await expect(text(relocked)).rejects.toMatchObject({ name: 'PasswordException' });
    expect((await text(relocked, '1234'))[0]).toContain('Account statement');
  }, 30_000);

  it('rejects files that are not PDFs', async () => {
    await expect(decryptPdfBytes(new Uint8Array(), '', wasm)).rejects.toMatchObject({ code: 'invalid' });
    await expect(decryptPdfBytes(new TextEncoder().encode('not a pdf'), '', wasm)).rejects.toMatchObject({ code: 'failed' });
  }, 30_000);
});
