import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PdfPasswordError } from './passwordError';
import { pdfjs } from './worker';

/** How a PDF was protected before HighPal unlocked it on the device. */
export type PdfProtection = 'none' | 'restricted' | 'password';

/** pdf.js detaches the buffer it is given, so it always gets its own copy. */
export async function openWithPdfjs(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  try {
    return await pdfjs.getDocument({ data: bytes.slice(), password: password || undefined, fontExtraProperties: true }).promise;
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new PdfPasswordError((error as Error & { code?: number }).code === 2 ? 'incorrect' : 'needed');
    }
    throw error;
  }
}

/** Locked and restricted PDFs both carry an encryption dictionary; pdf.js reports its filter name. */
export async function isEncrypted(doc: PDFDocumentProxy): Promise<boolean> {
  try {
    const { info } = await doc.getMetadata();
    return Boolean((info as { EncryptFilterName?: unknown }).EncryptFilterName);
  } catch {
    return false;
  }
}

/** Makes an unlocked copy in a disposable worker. Loaded only when a protected PDF turns up. */
export async function removeProtection(bytes: Uint8Array, password?: string): Promise<Uint8Array> {
  const { unlockPdf } = await import('@/lib/unlockPdf/client');
  return unlockPdf(bytes, password || '');
}

/** Returns the bytes unchanged for ordinary PDFs, or an unlocked copy. Throws PdfPasswordError when a password is needed. */
export async function unlockPdfBytes(bytes: Uint8Array, password?: string): Promise<{ bytes: Uint8Array; protection: PdfProtection }> {
  const doc = await openWithPdfjs(bytes, password);
  let encrypted: boolean;
  try { encrypted = await isEncrypted(doc); } finally { await doc.destroy(); }
  if (!encrypted) return { bytes, protection: 'none' };
  return { bytes: await removeProtection(bytes, password), protection: password ? 'password' : 'restricted' };
}

const unlockedFiles = new WeakSet<File>();

/** True for a file HighPal unlocked in this tab (the Unlock PDF tool uses this to know there was a lock). */
export function wasUnlocked(file: File): boolean {
  return unlockedFiles.has(file);
}

/** The same file for ordinary PDFs, or an unlocked copy with the same name. */
export async function unlockPdfFile(file: File, password?: string): Promise<{ file: File; protection: PdfProtection }> {
  const result = await unlockPdfBytes(new Uint8Array(await file.arrayBuffer()), password);
  if (result.protection === 'none') return { file, protection: 'none' };
  const unlocked = new File([result.bytes.slice().buffer], file.name, { type: 'application/pdf', lastModified: file.lastModified });
  unlockedFiles.add(unlocked);
  return { file: unlocked, protection: result.protection };
}
