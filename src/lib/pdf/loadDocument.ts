import { pdfjs } from './worker';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PageGeometry } from './types';

export interface LoadedDocument {
  doc: PDFDocumentProxy;
  /**
   * Pristine copy of the original file bytes. This is the ONLY thing the
   * export path ever hands to pdf-lib. It is never passed to pdf.js, because
   * `getDocument({ data })` DETACHES (neuters) the buffer it receives.
   */
  originalBytes: Uint8Array;
  pages: PageGeometry[];
}

async function toBytes(source: File | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (source instanceof File) return new Uint8Array(await source.arrayBuffer());
  if (source instanceof Uint8Array) return source;
  return new Uint8Array(source);
}

export async function loadDocument(
  source: File | ArrayBuffer | Uint8Array,
): Promise<LoadedDocument> {
  const bytes = await toBytes(source);

  // Two independent copies (slice() copies): one kept pristine for export, one
  // thrown to pdf.js (which detaches whatever buffer it's given).
  const originalBytes = bytes.slice();
  const forPdfjs = bytes.slice();

  const doc = await pdfjs.getDocument({ data: forPdfjs }).promise;
  const pages = await collectGeometry(doc);
  return { doc, originalBytes, pages };
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
