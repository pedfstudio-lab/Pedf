import type { PageGeometry } from '@/lib/pdf/types';

/** An sRGB color with channels normalized to the inclusive range 0..1. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * A rectangle in unrotated PDF user space.
 *
 * Its origin is at the bottom-left of the page and all values are PDF points.
 */
export interface PdfRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Source text styling captured by the overlay and consumed by the text handler. */
export interface TextStyle {
  readonly fontName: string;
  readonly fontSizePt: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly color: Rgb;
}

/** Inline weight/style override; family, size, and color inherit from the containing TextEdit. */
export interface TextSpan {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
}

export type EditKind = 'text' | 'cover' | 'image';

export interface BaseEdit {
  readonly id: string;
  readonly kind: EditKind;
  readonly pageIndex: number;
  readonly rect: PdfRect;
  readonly z: number;
}

export interface TextEdit extends BaseEdit {
  readonly kind: 'text';
  readonly text: string;
  readonly style: TextStyle;
  /** Feature-side marker for text placed without an underlying source block or cover. */
  readonly origin?: 'free';
  /** Groups the wrapped line edits that belong to one placed free-text box. */
  readonly boxId?: string;
  /** Present only when weight/style varies within this wrapped line. */
  readonly spans?: readonly TextSpan[];
  /** Unwrapped editor value retained so changing width on re-edit recomputes soft wraps. */
  readonly boxText?: string;
  /** Unwrapped rich value retained so re-editing does not lose styles at soft-wrap boundaries. */
  readonly boxSpans?: readonly TextSpan[];
  /** Manual editor-box height in PDF points; repeated on wrapped line edits for re-editing. */
  readonly boxHeight?: number;
}

export interface CoverEdit extends BaseEdit {
  readonly kind: 'cover';
  readonly color?: Rgb;
  readonly sampleBackground: boolean;
}

export interface ImageEdit extends BaseEdit {
  readonly kind: 'image';
  /** Original encoded PNG/JPEG bytes; never re-sampled before embedding. */
  readonly bytes: Uint8Array;
}

/** The closed union consumed exhaustively by the export-handler registry. */
export type Edit = TextEdit | CoverEdit | ImageEdit;

export interface EditDocument {
  /** Pristine source bytes. Only pdf-lib may consume this copy. */
  readonly originalBytes: Uint8Array;
  edits: Edit[];
  pages: PageGeometry[];
  sampleBackground?: (pageIndex: number, rect: PdfRect) => Rgb;
}
