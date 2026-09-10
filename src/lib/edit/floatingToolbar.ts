import { useLayoutEffect, useState } from 'react';
import type { ScreenRect } from '@/lib/export/coordinates';

export interface ElementSize {
  readonly width: number;
  readonly height: number;
}

export const TOOLBAR_GAP_PX = 12;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Where a floating toolbar (Done / Cancel, W × H, text formatting…) goes for a selection frame, in
 * page CSS pixels. The page box clips anything outside it, so the bar is kept inside: it sits above
 * the frame when there is room, otherwise below, and is pulled back in at the page edges. It follows
 * the frame's left edge as long as that keeps the whole bar on the page.
 */
export function placeSelectionToolbar(
  frame: ScreenRect,
  toolbar: ElementSize,
  page: ElementSize,
  gap: number = TOOLBAR_GAP_PX,
): { left: number; top: number } {
  const left = clamp(frame.left, 0, Math.max(0, page.width - toolbar.width));
  const above = frame.top - toolbar.height - gap;
  const below = frame.top + frame.height + gap;
  const top = above >= 0 ? above : Math.min(below, Math.max(0, page.height - toolbar.height));
  return { left, top };
}

/** The same placement, expressed as an offset from the frame's own top-left corner. */
export function toolbarOffsetInFrame(
  frame: ScreenRect,
  toolbar: ElementSize,
  page: ElementSize,
  gap: number = TOOLBAR_GAP_PX,
): { left: number; top: number } {
  const placed = placeSelectionToolbar(frame, toolbar, page, gap);
  return { left: placed.left - frame.left, top: placed.top - frame.top };
}

/**
 * Live size of an element (zero while it is not mounted), for placing floating toolbars.
 * Returns a callback ref: pass it as `ref` and the size follows every mount, unmount, and resize.
 */
export function useElementSize<T extends HTMLElement>(): [(node: T | null) => void, ElementSize] {
  const [node, setNode] = useState<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!node) {
      setSize((current) => (current.width === 0 && current.height === 0 ? current : { width: 0, height: 0 }));
      return;
    }
    const measure = () => setSize((current) => {
      const next = { width: node.offsetWidth, height: node.offsetHeight };
      return current.width === next.width && current.height === next.height ? current : next;
    });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, size];
}
