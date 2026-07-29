/**
 * Geometry of one page, captured once at load time from an unrotated,
 * scale-1 viewport. This is what the export path uses to place edits —
 * it is independent of zoom and devicePixelRatio.
 */
export interface PageGeometry {
  pageIndex: number; // 0-based
  /** Unrotated page width in PDF points (viewBox width). */
  widthPt: number;
  /** Unrotated page height in PDF points (viewBox height). */
  heightPt: number;
  /** The page's /Rotate value, normalized to [0, 90, 180, 270]. */
  rotation: 0 | 90 | 180 | 270;
  /** Lower-left corner of the view box in PDF points (usually {0,0}). */
  boxOffset: { x: number; y: number };
}
