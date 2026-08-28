export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.25;

export interface ZoomAnchor {
  readonly v: number;
  readonly h: number;
}

export interface ZoomScrollMetrics {
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
  readonly clientHeight: number;
  readonly clientWidth: number;
}

export type ZoomExtentMetrics = Pick<
  ZoomScrollMetrics,
  'scrollHeight' | 'scrollWidth' | 'clientHeight' | 'clientWidth'
>;

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));
}

/** Capture the content under the viewport center as scrollable-content fractions. */
export function captureZoomAnchor(metrics: ZoomScrollMetrics): ZoomAnchor {
  return {
    v: metrics.scrollHeight > 0
      ? (metrics.scrollTop + metrics.clientHeight / 2) / metrics.scrollHeight
      : 0,
    h: metrics.scrollWidth > 0
      ? (metrics.scrollLeft + metrics.clientWidth / 2) / metrics.scrollWidth
      : 0,
  };
}

/** Map a captured focal point onto content after its zoomed dimensions settle. */
export function scrollPositionForZoomAnchor(
  anchor: ZoomAnchor,
  metrics: ZoomExtentMetrics,
): { readonly top: number; readonly left: number } {
  return {
    top: anchor.v * metrics.scrollHeight - metrics.clientHeight / 2,
    left: anchor.h * metrics.scrollWidth - metrics.clientWidth / 2,
  };
}
