import createModule from '@neslinesli93/qpdf-wasm';
import { EncryptedPDFError, PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { passwordProblem } from './password';
import { LockPdfError, MAX_LOCK_BYTES, type LockProgress } from './protocol';

/** Runs in a disposable worker. No document/password reaches a server or a log. */
export async function encryptPdfBytes(bytes: Uint8Array, password: string, wasmLocation: string,
  progress?: (phase: LockProgress) => void): Promise<Uint8Array> {
  if (passwordProblem(password, password)) throw new LockPdfError('password');
  if (!bytes.length || bytes.length > MAX_LOCK_BYTES) throw new LockPdfError('invalid');
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new LockPdfError('unsupported');
  progress?.('checking');
  let source: PDFDocument;
  try { source = await PDFDocument.load(bytes, { throwOnInvalidObject: true, updateMetadata: false }); }
  catch (error) {
    // Encrypted object streams can fail parsing before pdf-lib constructs its
    // EncryptedPDFError. This fallback only classifies a refused input; it never
    // authorizes decryption or allows a file through validation.
    const encryptionMarker = /\/Encrypt\s+(?:\d+\s+\d+\s+R|<<)/u.test(new TextDecoder('latin1').decode(bytes));
    throw new LockPdfError(error instanceof EncryptedPDFError || (error instanceof Error
      && (error.name === 'EncryptedPDFError' || error.message === new EncryptedPDFError().message)) || encryptionMarker ? 'locked' : 'invalid');
  }
  if (!source.getPageCount()) throw new LockPdfError('invalid');
  const signed = source.context.enumerateIndirectObjects().some(([, object]) => object instanceof PDFDict
    && (object.get(PDFName.of('Type')) === PDFName.of('Sig') || object.get(PDFName.of('Type')) === PDFName.of('DocTimeStamp')
      || (object.has(PDFName.of('ByteRange')) && object.has(PDFName.of('Contents')))));
  if (signed) throw new LockPdfError('signed');

  // Never leave the owner password empty: that would allow opening without the user password.
  const random = crypto.getRandomValues(new Uint8Array(32));
  const ownerPassword = [...random].map(value => value.toString(16).padStart(2, '0')).join('');
  random.fill(0);
  if (ownerPassword === password) throw new LockPdfError('failed');
  const module = await createModule({ locateFile: () => wasmLocation });
  const fs = module.FS as typeof module.FS & { writeFile(path: string, data: Uint8Array): void; unlink(path: string): void };
  try {
    fs.writeFile('/input.pdf', bytes);
    progress?.('encrypting');
    const status = module.callMain(['/input.pdf', '--stream-data=preserve', '--object-streams=preserve',
      '--encrypt', `--user-password=${password}`, `--owner-password=${ownerPassword}`, '--bits=256', '--', '/locked.pdf']);
    // A warning/repair result is not silently presented as a clean encrypted download.
    if (status !== 0) throw new LockPdfError('failed');
    const output = Uint8Array.from(fs.readFile('/locked.pdf'));
    const text = new TextDecoder('latin1').decode(output);
    if (!text.startsWith('%PDF-') || !/\/Encrypt\s+\d+\s+\d+\s+R/u.test(text)) throw new LockPdfError('failed');
    return output;
  } finally {
    for (const path of ['/input.pdf', '/locked.pdf']) { try { fs.unlink(path); } catch { /* May not have been created. */ } }
  }
}
