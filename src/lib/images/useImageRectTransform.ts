import { useCallback } from 'react';
import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import { pdfRectToScreenRect, screenRectToPdfRect } from '@/lib/export/coordinates';
import type { PdfRect } from '@/lib/export/types';
import type { ScreenRect } from '@/lib/export/coordinates';

export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

export const MIN_IMAGE_SIZE_PT = 20;
export const POINTS_PER_MM = 72 / 25.4;
export const BACKGROUND_AREA_RATIO = 0.9;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function isBackgroundRegion(rect: PdfRect, pageRect: PdfRect): boolean {
  if (rect.w <= 0 || rect.h <= 0 || pageRect.w <= 0 || pageRect.h <= 0) return false;
  return rect.w * rect.h >= pageRect.w * pageRect.h * BACKGROUND_AREA_RATIO;
}

export function moveScreenRect(
  rect: ScreenRect,
  dx: number,
  dy: number,
  pageWidth: number,
  pageHeight: number,
): ScreenRect {
  return {
    ...rect,
    left: clamp(rect.left + dx, 0, Math.max(0, pageWidth - rect.width)),
    top: clamp(rect.top + dy, 0, Math.max(0, pageHeight - rect.height)),
  };
}

export function resizeScreenRect(
  rect: ScreenRect,
  corner: ResizeCorner,
  dx: number,
  dy: number,
  pageWidth: number,
  pageHeight: number,
  minimum: number,
): ScreenRect {
  const horizontal = corner.endsWith('e') ? dx : -dx;
  const vertical = corner.startsWith('s') ? dy : -dy;
  const horizontalScale = (rect.width + horizontal) / rect.width;
  const verticalScale = (rect.height + vertical) / rect.height;
  const requested = Math.abs(horizontalScale - 1) >= Math.abs(verticalScale - 1)
    ? horizontalScale
    : verticalScale;
  const anchorX = corner.endsWith('e') ? rect.left : rect.left + rect.width;
  const anchorY = corner.startsWith('s') ? rect.top : rect.top + rect.height;
  const maxWidth = corner.endsWith('e') ? pageWidth - anchorX : anchorX;
  const maxHeight = corner.startsWith('s') ? pageHeight - anchorY : anchorY;
  const minimumScale = Math.max(minimum / rect.width, minimum / rect.height);
  const maximumScale = Math.min(maxWidth / rect.width, maxHeight / rect.height);
  const scale = clamp(requested, Math.min(minimumScale, maximumScale), maximumScale);
  const width = rect.width * scale;
  const height = rect.height * scale;
  return {
    left: corner.endsWith('e') ? anchorX : anchorX - width,
    top: corner.startsWith('s') ? anchorY : anchorY - height,
    width,
    height,
  };
}

export function resizePdfRectByMillimetres(
  rect: PdfRect,
  pageRect: PdfRect,
  dimension: 'width' | 'height',
  millimetres: number,
): PdfRect {
  if (!Number.isFinite(millimetres) || millimetres <= 0 || rect.w <= 0 || rect.h <= 0) return rect;
  const requested = millimetres * POINTS_PER_MM;
  const scale = dimension === 'width' ? requested / rect.w : requested / rect.h;
  const maximumScale = Math.min(pageRect.w / rect.w, pageRect.h / rect.h);
  const minimumScale = Math.max(MIN_IMAGE_SIZE_PT / rect.w, MIN_IMAGE_SIZE_PT / rect.h);
  const boundedScale = clamp(scale, Math.min(minimumScale, maximumScale), maximumScale);
  const width = rect.w * boundedScale;
  const height = rect.h * boundedScale;
  const centerX = rect.x + rect.w / 2;
  const centerY = rect.y + rect.h / 2;
  return {
    x: clamp(centerX - width / 2, pageRect.x, pageRect.x + pageRect.w - width),
    y: clamp(centerY - height / 2, pageRect.y, pageRect.y + pageRect.h - height),
    w: width,
    h: height,
  };
}

interface ImageRectTransformOptions {
  readonly rect?: PdfRect;
  readonly setRect: Dispatch<SetStateAction<PdfRect | undefined>>;
  readonly viewport: PageViewport;
  readonly dpr: number;
}

/** Shared pointer and keyboard geometry for new-image drafts and selected images. */
export function useImageRectTransform({ rect, setRect, viewport, dpr }: ImageRectTransformOptions) {
  const begin = useCallback((
    mode: 'move' | 'resize',
    corner: ResizeCorner,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (!rect) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = pdfRectToScreenRect(rect, viewport, dpr);
    const pageWidth = viewport.width / dpr;
    const pageHeight = viewport.height / dpr;
    const minimum = MIN_IMAGE_SIZE_PT * viewport.scale / dpr;
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const next = mode === 'move'
        ? moveScreenRect(start, dx, dy, pageWidth, pageHeight)
        : resizeScreenRect(start, corner, dx, dy, pageWidth, pageHeight, minimum);
      setRect(screenRectToPdfRect(next, viewport, dpr));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }, [dpr, rect, setRect, viewport]);

  const beginMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => begin('move', 'se', event),
    [begin],
  );
  const beginResize = useCallback(
    (corner: ResizeCorner, event: ReactPointerEvent<HTMLElement>) => begin('resize', corner, event),
    [begin],
  );
  const nudge = useCallback((dxPt: number, dyPt: number) => {
    if (!rect) return;
    const screen = pdfRectToScreenRect(rect, viewport, dpr);
    const pixelsPerPoint = viewport.scale / dpr;
    const next = moveScreenRect(
      screen,
      dxPt * pixelsPerPoint,
      dyPt * pixelsPerPoint,
      viewport.width / dpr,
      viewport.height / dpr,
    );
    setRect(screenRectToPdfRect(next, viewport, dpr));
  }, [dpr, rect, setRect, viewport]);

  return { beginMove, beginResize, nudge };
}
