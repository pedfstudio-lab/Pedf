import type { TextStyle } from '@/lib/export/types';
import { calibrateSourceFont, matchFont, matchedCssFamily } from './fontMatch';

type ByteLoader = (path: string) => Promise<Uint8Array>;
let loader: ByteLoader = async path => {
  const response = await fetch(`${import.meta.env.BASE_URL}fonts/${path}`);
  if (!response.ok) throw new Error(`Font ${path}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};
const bytes = new Map<string, Promise<Uint8Array>>();
const faces = new Map<string, Promise<void>>();
/** Injection for offline tests; production always uses the site's own /fonts/. */
export function setFontByteLoader(value: ByteLoader): void { loader = value; bytes.clear(); faces.clear(); }
export function loadFontBytes(file: string): Promise<Uint8Array> {
  let pending = bytes.get(file);
  if (!pending) {
    pending = loader(file).catch(error => { bytes.delete(file); throw error; });
    bytes.set(file, pending);
  }
  return pending;
}
export async function ensureMatchedFont(style: TextStyle): Promise<void> {
  const match = matchFont(style), family = matchedCssFamily(style);
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  if (!faces.has(family)) {
    const file = !match.exact && match.scale !== 1 ? `r1width/${match.family.replace('Liberation','R1Width')}-${match.file.split('-').at(-1)}` : match.file;
    const pending = loadFontBytes(file).then(async data => {
      const face = new FontFace(family, data.slice().buffer as ArrayBuffer, {
        weight: style.bold && !match.syntheticBold ? '700' : '400', style: style.italic && !match.syntheticItalic ? 'italic' : 'normal',
        ...(!match.exact && match.scale !== 1 ? { variationSettings: `'wdth' ${match.scale * 100}` } : {}),
      });
      await face.load(); document.fonts.add(face);
    }).catch(error => { faces.delete(family); throw error; });
    faces.set(family, pending);
  }
  await faces.get(family);
}
export async function prepareSourceFont(ref: string, style: TextStyle, pageRefs?: readonly string[]): Promise<void> {
  const match = matchFont(style);
  if (!match.exact) calibrateSourceFont(ref, await loadFontBytes(match.file), pageRefs);
}
