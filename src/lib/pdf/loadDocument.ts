import type { PDFDocumentProxy } from 'pdfjs-dist';
import { isEncrypted, openWithPdfjs, removeProtection, type PdfProtection } from './protection';
import type { PageGeometry } from './types';

export interface LoadedDocument {
  doc: PDFDocumentProxy;
  /**
   * Pristine copy of the original file bytes. This is the ONLY thing the
   * export path ever hands to pdf-lib. It is never passed to pdf.js, because
   * `getDocument({ data })` DETACHES (neuters) the buffer it receives.
   * For a locked or restricted PDF these are the unlocked copy's bytes.
   */
  originalBytes: Uint8Array;
  pages: PageGeometry[];
  /** How the file was protected before it was unlocked on the device (absent = not protected). */
  protection?: PdfProtection;
}

async function toBytes(source: File | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (source instanceof File) return new Uint8Array(await source.arrayBuffer());
  if (source instanceof Uint8Array) return source;
  return new Uint8Array(source);
}

/**
 * Opens a PDF. Locked and restricted PDFs are unlocked on the device first, so editing,
 * saving and exporting see an ordinary file. Throws PdfPasswordError when a password is needed.
 */
export async function loadDocument(
  source: File | ArrayBuffer | Uint8Array,
  options: { password?: string } = {},
): Promise<LoadedDocument> {
  let bytes = await toBytes(source);
  const password = options.password || undefined;
  let doc = await openWithPdfjs(bytes, password);
  let protection: PdfProtection = 'none';
  if (await isEncrypted(doc)) {
    await doc.destroy();
    bytes = await removeProtection(bytes, password);
    protection = password ? 'password' : 'restricted';
    doc = await openWithPdfjs(bytes);
  }
  // Its own copy (slice() copies), separate from the one pdf.js was given.
  const originalBytes = bytes.slice();
  const pages = await collectGeometry(doc);
  return { doc, originalBytes, pages, protection };
}

async function collectGeometry(doc: PDFDocumentProxy): Promise<PageGeometry[]> {
  const out: PageGeometry[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    // rotation:0 → the *unrotated* view box, which is the space edits are stored in.
    const vp = page.getViewport({ scale: 1, rotation: 0 });
    const vb = vp.viewBox;
    const x0 = vb[0] ?? 0;
    const y0 = vb[1] ?? 0;
    const x1 = vb[2] ?? 0;
    const y1 = vb[3] ?? 0;
    out.push({
      pageIndex: i - 1,
      widthPt: x1 - x0,
      heightPt: y1 - y0,
      rotation: (((page.rotate % 360) + 360) % 360) as PageGeometry['rotation'],
      boxOffset: { x: x0, y: y0 },
    });
  }
  return out;
}
