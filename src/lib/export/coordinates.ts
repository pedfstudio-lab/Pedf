import type { PageViewport } from 'pdfjs-dist';
import type { PageGeometry } from '@/lib/pdf/types';
import type { PdfRect } from './types';

type TaggedPoint<Space extends string> = {
  readonly x: number;
  readonly y: number;
  readonly __space?: Space;
};

/** CSS pixels relative to the top-left of a rendered page. */
export type ScreenPx = TaggedPoint<'screen'>;
export type ScreenPt = ScreenPx;

/** Device pixels in the PDF.js viewport (rotation already applied). */
export type ViewportPx = TaggedPoint<'viewport'>;
export type ViewportPt = ViewportPx;

/** Unrotated PDF user-space points, with a bottom-left origin. */
export type PdfPt = TaggedPoint<'pdf'>;

export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function toPoint<Space extends string>(pair: ArrayLike<number>, source: string): TaggedPoint<Space> {
  const x = pair[0];
  const y = pair[1];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${source} returned an invalid coordinate pair`);
  }
  return { x, y };
}

/** Convert CSS pixels into the backing-store pixels used by PDF.js. */
export function screenToViewport(point: ScreenPt, dpr: number): ViewportPt {
  assertPositiveFinite(dpr, 'dpr');
  return { x: point.x * dpr, y: point.y * dpr };
}

/** Convert PDF.js backing-store pixels into CSS pixels. */
export function viewportToScreen(point: ViewportPt, dpr: number): ScreenPt {
  assertPositiveFinite(dpr, 'dpr');
  return { x: point.x / dpr, y: point.y / dpr };
}

/** PDF.js is the runtime source of truth for rotation-aware viewport conversion. */
export function viewportToPdf(viewport: PageViewport, point: ViewportPt): PdfPt {
  return toPoint<'pdf'>(viewport.convertToPdfPoint(point.x, point.y), 'convertToPdfPoint');
}

/** PDF.js is the runtime source of truth for rotation-aware viewport conversion. */
export function pdfToViewport(viewport: PageViewport, point: PdfPt): ViewportPt {
  return toPoint<'viewport'>(
    viewport.convertToViewportPoint(point.x, point.y),
    'convertToViewportPoint',
  );
}

export function screenToPdf(viewport: PageViewport, point: ScreenPt, dpr: number): PdfPt {
  return viewportToPdf(viewport, screenToViewport(point, dpr));
}

export function pdfToScreen(viewport: PageViewport, point: PdfPt, dpr: number): ScreenPt {
  return viewportToScreen(pdfToViewport(viewport, point), dpr);
}

/**
 * Convert a CSS rectangle to an axis-aligned rectangle in unrotated PDF space.
 * Opposite corners are normalized so 90/270-degree rotations safely swap axes.
 */
export function screenRectToPdfRect(
  rect: ScreenRect,
  viewport: PageViewport,
  dpr: number,
): PdfRect {
  const a = screenToPdf(viewport, { x: rect.left, y: rect.top }, dpr);
  const b = screenToPdf(
    viewport,
    { x: rect.left + rect.width, y: rect.top + rect.height },
    dpr,
  );

  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** Convert an unrotated PDF rectangle back to a normalized CSS rectangle. */
export function pdfRectToScreenRect(
  rect: PdfRect,
  viewport: PageViewport,
  dpr: number,
): ScreenRect {
  const a = pdfToScreen(viewport, { x: rect.x, y: rect.y }, dpr);
  const b = pdfToScreen(viewport, { x: rect.x + rect.w, y: rect.y + rect.h }, dpr);

  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/**
 * Closed-form viewport-to-PDF fallback, also used to cross-check PDF.js in tests.
 * `renderScale` must be the viewport scale (`zoom * dpr`).
 */
export function closedFormViewportToPdf(
  point: ViewportPt,
  page: PageGeometry,
  renderScale: number,
): PdfPt {
  assertPositiveFinite(renderScale, 'renderScale');

  const vx = point.x / renderScale;
  const vy = point.y / renderScale;
  const { x: x0, y: y0 } = page.boxOffset;

  switch (page.rotation) {
    case 0:
      return { x: x0 + vx, y: y0 + page.heightPt - vy };
    case 90:
      return { x: x0 + vy, y: y0 + vx };
    case 180:
      return { x: x0 + page.widthPt - vx, y: y0 + vy };
    case 270:
      return { x: x0 + page.widthPt - vy, y: y0 + page.heightPt - vx };
  }
}
