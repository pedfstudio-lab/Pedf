import createModule from '@neslinesli93/qpdf-wasm';
import { MAX_UNLOCK_BYTES, UnlockPdfError } from './protocol';

const ENCRYPTION_MARKER = /\/Encrypt\s+(?:\d+\s+\d+\s+R|<<)/u;

/**
 * Removes a PDF's password lock or editing restrictions, on the device, in a disposable worker.
 * `password` is the one the person typed (empty for files that open without one). It is only
 * handed to qpdf as a single argument, so it can never be read as an option.
 */
export async function decryptPdfBytes(bytes: Uint8Array, password: string, wasmLocation: string): Promise<Uint8Array> {
  if (!bytes.length || bytes.length > MAX_UNLOCK_BYTES) throw new UnlockPdfError('invalid');
  const module = await createModule({ locateFile: () => wasmLocation });
  const fs = module.FS as typeof module.FS & { writeFile(path: string, data: Uint8Array): void; unlink(path: string): void };
  try {
    fs.writeFile('/input.pdf', bytes);
    const status = module.callMain(['--decrypt', ...(password ? [`--password=${password}`] : []), '/input.pdf', '/unlocked.pdf']);
    // 0 = clean, 3 = written with warnings (common for slightly untidy bank PDFs). 2 = refused.
    if (status !== 0 && status !== 3) throw new UnlockPdfError(password ? 'password' : 'failed');
    const output = Uint8Array.from(fs.readFile('/unlocked.pdf'));
    const text = new TextDecoder('latin1').decode(output);
    if (!text.startsWith('%PDF-') || ENCRYPTION_MARKER.test(text)) throw new UnlockPdfError('failed');
    return output;
  } finally {
    for (const path of ['/input.pdf', '/unlocked.pdf']) { try { fs.unlink(path); } catch { /* May not have been created. */ } }
  }
}
