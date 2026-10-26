import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { degrees, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { encryptPdfBytes } from './engine';

const wasm = resolve('node_modules/@neslinesli93/qpdf-wasm/dist/qpdf.wasm');
export const TEST_PASSWORD = 'Local PDF test! 2026';
async function sample() {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Lock PDF verification');
  pdf.setAuthor('Local test fixture');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([420, 595]);
  page.drawText('Lock PDF - confidential sample', { x: 35, y: 540, size: 18, font });
  page.drawText('Original text, spacing and artwork stay unchanged.', { x: 35, y: 500, size: 12, font });
  page.drawRectangle({ x: 35, y: 370, width: 350, height: 65 });
  const field = pdf.getForm().createTextField('customer');
  field.setText('Sample customer'); field.addToPage(page, { x: 35, y: 320, width: 250, height: 25 });
  const second = pdf.addPage([300, 400]); second.setRotation(degrees(90));
  second.drawText('Second page with rotation', { x: 25, y: 300, font, size: 12 });
  return pdf.save();
}
async function inspect(bytes: Uint8Array, password?: string) {
  const task = getDocument({ data: bytes.slice(), password, verbosity: 0 });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      // pdf.js allocates a new session-local fontName on every load. Compare
      // the real font style and every text position/advance, not that runtime id.
      pages.push({ text: content.items.map(item => {
        if (!('str' in item)) return item;
        return { str: item.str, dir: item.dir, height: item.height, width: item.width, transform: item.transform,
          hasEOL: item.hasEOL, font: content.styles[item.fontName] };
      }), view: page.view, rotation: page.rotate,
        annotations: (await page.getAnnotations()).map(item => ({ fieldName: item.fieldName, fieldValue: item.fieldValue, rect: item.rect })) });
    }
    const metadata = (await pdf.getMetadata()).info;
    return { pages, metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'IsEncrypted' && key !== 'EncryptFilterName')) };
  } finally { await task.destroy(); }
}
afterEach(() => vi.unstubAllGlobals());

describe('real AES-256 PDF locking', () => {
  it('requires a password, rejects wrong passwords, and preserves pages, positions, form values and metadata', async () => {
    const input = await sample(), before = input.slice();
    const output = await encryptPdfBytes(input, TEST_PASSWORD, wasm);
    expect(input).toEqual(before);
    await expect(inspect(output)).rejects.toMatchObject({ name: 'PasswordException', code: 1 });
    await expect(inspect(output, 'wrong password')).rejects.toMatchObject({ name: 'PasswordException', code: 2 });
    expect(await inspect(output, TEST_PASSWORD)).toEqual(await inspect(input));
    const raw = await PDFDocument.load(output, { ignoreEncryption: true, updateMetadata: false });
    expect(raw.isEncrypted).toBe(true);
    const encryption = raw.context.lookup(raw.context.trailerInfo.Encrypt!) as PDFDict;
    expect((encryption.get(PDFName.of('V')) as PDFNumber).asNumber()).toBe(5);
    expect((encryption.get(PDFName.of('R')) as PDFNumber).asNumber()).toBe(6);
    expect((encryption.get(PDFName.of('Length')) as PDFNumber).asNumber()).toBe(256);
    const filters = raw.context.lookup(encryption.get(PDFName.of('CF'))!) as PDFDict;
    const standard = raw.context.lookup(filters.get(PDFName.of('StdCF'))!) as PDFDict;
    expect(standard.get(PDFName.of('CFM'))).toBe(PDFName.of('AESV3'));
    await mkdir('tmp/lock-pdf', { recursive: true });
    await writeFile('tmp/lock-pdf/original.pdf', input);
    await writeFile('tmp/lock-pdf/locked.pdf', output);
  }, 30_000);

  it.each(['Hindi पासवर्ड 2026!', 'Café été 2026!', 'Emoji 🔒 passphrase', '--show-encryption-key'])('round-trips a supported password without treating it as a command: %s', async password => {
    const input = await sample();
    const output = await encryptPdfBytes(input, password, wasm);
    expect((await inspect(output, password)).pages).toEqual((await inspect(input)).pages);
  }, 30_000);

  it('never lets a previous file password open a later file', async () => {
    const bytes = await sample();
    const first = await encryptPdfBytes(bytes, TEST_PASSWORD, wasm);
    const second = await encryptPdfBytes(bytes, 'Another strong password!', wasm);
    expect(first).not.toEqual(second);
    await expect(inspect(second, TEST_PASSWORD)).rejects.toMatchObject({ code: 2 });
    expect((await inspect(second, 'Another strong password!')).pages).toHaveLength(2);
  }, 30_000);

  it('refuses already encrypted input rather than removing its protection', async () => {
    const output = await encryptPdfBytes(await sample(), TEST_PASSWORD, wasm);
    await expect(encryptPdfBytes(output, TEST_PASSWORD, wasm)).rejects.toMatchObject({ code: 'locked' });
  });
  it('refuses signed input instead of silently invalidating its signature', async () => {
    const pdf = await PDFDocument.load(await sample());
    pdf.context.register(pdf.context.obj({ Type: 'Sig', ByteRange: [0, 10, 20, 30], Contents: PDFString.of('test') }));
    await expect(encryptPdfBytes(await pdf.save(), TEST_PASSWORD, wasm)).rejects.toMatchObject({ code: 'signed' });
  });
  it('fails closed without secure randomness and on invalid PDFs or passwords', async () => {
    const input = await sample();
    await expect(encryptPdfBytes(new Uint8Array([1, 2, 3]), TEST_PASSWORD, wasm)).rejects.toMatchObject({ code: 'invalid' });
    await expect(encryptPdfBytes(input, '', wasm)).rejects.toMatchObject({ code: 'password' });
    vi.stubGlobal('crypto', undefined);
    await expect(encryptPdfBytes(input, TEST_PASSWORD, wasm)).rejects.toMatchObject({ code: 'unsupported' });
  });
});
