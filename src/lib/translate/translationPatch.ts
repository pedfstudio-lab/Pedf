import type { PageViewport } from 'pdfjs-dist';
import type { PdfRect, Rgb } from '@/lib/export/types';
import { sampleCanvasTextBackground } from '@/lib/export/inkExtent';

/**
 * What sits behind translated words until the clean page is ready: the page's own colour where
 * the box is plain text on a flat colour (it already looks final), a frosted patch over a photo.
 */
export interface TranslationPatch { readonly look: 'solid' | 'frosted'; readonly color: Rgb }

const WHITE: TranslationPatch = { look: 'solid', color: { r: 1, g: 1, b: 1 } };
/** Inside the box: share of pixels that must be the background, the text colour, or an anti-aliased mix. */
const INNER_SHARE = 0.95;
/** The margin has no text: share of pixels that must be the background itself (or a rule in the text colour). */
const MARGIN_SHARE = 0.9;
// Tight: a smooth area of a photo is not flat, and a solid patch there shows as a block.
const DISTANCE = 12;

/** A patch reaches a little past its box, so ascenders, descenders and bullets are covered too. */
export function patchRect(rect: PdfRect, fontSizePt: number): PdfRect {
  const pad = fontSizePt * 0.2;
  return { x: rect.x - pad, y: rect.y - pad, w: rect.w + 2 * pad, h: rect.h + 2 * pad };
}

/**
 * `pixels` covers the whole patch (width × height); `inner` is the box inside it. A gradient behind
 * light text can look like anti-aliasing inside the box, which is why the margin is judged on its own.
 */
export function isFlatTextBackground(pixels: Uint8ClampedArray, width: number,
  inner: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number },
  background: Rgb, text: Rgb): boolean {
  const [br, bg, bb] = [background.r * 255, background.g * 255, background.b * 255];
  const [ar, ag, ab] = [text.r * 255 - br, text.g * 255 - bg, text.b * 255 - bb];
  const length = ar * ar + ag * ag + ab * ab, limit = DISTANCE * DISTANCE;
  let inside = 0, insideFlat = 0, margin = 0, marginFlat = 0;
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    if (pixels[offset + 3]! < 128) continue;
    const pixel = offset / 4, x = pixel % width, y = Math.floor(pixel / width);
    const pr = pixels[offset]! - br, pg = pixels[offset + 1]! - bg, pb = pixels[offset + 2]! - bb;
    if (x < inner.left || x >= inner.right || y < inner.top || y >= inner.bottom) {
      // The background itself, or a rule drawn in the text colour; never a blend between them.
      const er = pr - ar, eg = pg - ag, eb = pb - ab;
      margin += 1;
      if (pr * pr + pg * pg + pb * pb < limit || er * er + eg * eg + eb * eb < limit) marginFlat += 1;
      continue;
    }
    const along = length ? Math.min(1, Math.max(0, (pr * ar + pg * ag + pb * ab) / length)) : 0;
    const dr = pr - along * ar, dg = pg - along * ag, db = pb - along * ab;
    inside += 1;
    if (dr * dr + dg * dg + db * db < limit) insideFlat += 1;
  }
  return (margin === 0 || marginFlat / margin >= MARGIN_SHARE) && (inside === 0 || insideFlat / inside >= INNER_SHARE);
}

export function translationPatch(canvas: HTMLCanvasElement | undefined, viewport: PageViewport | undefined,
  rect: PdfRect, fontSizePt: number, textColor: Rgb): TranslationPatch {
  const context = canvas?.getContext('2d', { willReadFrequently: true });
  if (!canvas || !viewport || !context) return WHITE;
  const read = (x: number, y: number, width: number, height: number) => context.getImageData(x, y, width, height).data;
  const patch = patchRect(rect, fontSizePt);
  const color = sampleCanvasTextBackground({ width: canvas.width, height: canvas.height, read }, viewport, patch, textColor);
  const box = (area: PdfRect) => {
    const [x1 = 0, y1 = 0] = viewport.convertToViewportPoint(area.x, area.y);
    const [x2 = 0, y2 = 0] = viewport.convertToViewportPoint(area.x + area.w, area.y + area.h);
    return { left: Math.max(0, Math.floor(Math.min(x1, x2))), top: Math.max(0, Math.floor(Math.min(y1, y2))),
      right: Math.min(canvas.width, Math.ceil(Math.max(x1, x2))), bottom: Math.min(canvas.height, Math.ceil(Math.max(y1, y2))) };
  };
  const outer = box(patch), inner = box(rect);
  const width = outer.right - outer.left, height = outer.bottom - outer.top;
  if (width <= 0 || height <= 0) return { look: 'solid', color };
  try {
    const flat = isFlatTextBackground(read(outer.left, outer.top, width, height), width, {
      left: inner.left - outer.left, top: inner.top - outer.top, right: inner.right - outer.left, bottom: inner.bottom - outer.top,
    }, color, textColor);
    return { look: flat ? 'solid' : 'frosted', color };
  } catch { return { look: 'solid', color }; }
}
