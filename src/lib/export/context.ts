import { rgb } from 'pdf-lib';
import type { PDFDocument, PDFPage } from 'pdf-lib';
import type { PageGeometry } from '@/lib/pdf/types';
import type { EditDocument, PdfRect, Rgb } from './types';

export interface PageExportContext {
  readonly pdf: PDFDocument;
  readonly page: PDFPage;
  readonly geometry: PageGeometry;
  readonly warnings: string[];
  drawRect(rect: PdfRect, color: Rgb): void;
  sampleBackground(rect: PdfRect): Rgb | undefined;
}

export interface MakePageContextArgs {
  readonly pdf: PDFDocument;
  readonly page: PDFPage;
  readonly geometry: PageGeometry;
  readonly doc: EditDocument;
  readonly warnings: string[];
}

/** Build the complete and deliberately narrow capability set available to handlers. */
export function makePageContext({
  pdf,
  page,
  geometry,
  doc,
  warnings,
}: MakePageContextArgs): PageExportContext {
  return {
    pdf,
    page,
    geometry,
    warnings,
    drawRect(rect, color) {
      page.drawRectangle({
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        color: rgb(color.r, color.g, color.b),
      });
    },
    sampleBackground(rect) {
      return doc.sampleBackground?.(geometry.pageIndex, rect);
    },
  };
}
