export interface PageRenderIdentity {
  readonly page: object | undefined;
  readonly pageIndex: number;
  readonly blankWidth?: number;
  readonly blankHeight?: number;
}

/** Zoom is intentionally absent: analysis/render state belongs to page identity, not scale. */
export function samePageRenderIdentity(
  left: PageRenderIdentity,
  right: PageRenderIdentity,
): boolean {
  return (
    left.page === right.page
    && left.pageIndex === right.pageIndex
    && left.blankWidth === right.blankWidth
    && left.blankHeight === right.blankHeight
  );
}

/** Keep legacy eager rendering as a safe fallback in browsers without observation support. */
export function shouldRasterizeInitially(
  pageIndex: number,
  intersectionObserverAvailable: boolean,
): boolean {
  return pageIndex === 0 || !intersectionObserverAvailable;
}
