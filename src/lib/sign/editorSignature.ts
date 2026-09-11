import type { Edit, ImageEdit } from '@/lib/export/types';
import type { PageGeometry } from '@/lib/pdf/types';
import type { SignatureAsset } from '@/lib/tools/signOptions';

function identifier(): string {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fallback */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Turn a signature into the editor's ordinary image edit, centred on the chosen live page. */
export function editorSignatureEdit(
  signature: SignatureAsset,
  pageIndex: number,
  page: PageGeometry,
  edits: readonly Edit[],
  id = `signature-${identifier()}`,
): ImageEdit {
  const width = Math.min(160, page.widthPt * 0.8);
  const height = Math.min(page.heightPt * 0.8, width * signature.height / signature.width);
  return {
    id,
    kind: 'image',
    pageIndex,
    rect: {
      x: page.boxOffset.x + (page.widthPt - width) / 2,
      y: page.boxOffset.y + (page.heightPt - height) / 2,
      w: width,
      h: height,
    },
    z: Math.max(0, ...edits.map((edit) => edit.z)) + 1,
    bytes: signature.png,
  };
}
