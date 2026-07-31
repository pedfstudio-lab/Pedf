import type { PDFPageProxy } from 'pdfjs-dist';
import type { PdfRect, TextStyle } from '@/lib/export/types';
import { viewportToPdf } from '@/lib/export/coordinates';
import type { PdfPt, ViewportPt } from '@/lib/export/coordinates';

export interface TextRun {
  readonly pageIndex: number;
  readonly text: string;
  readonly rect: PdfRect;
  readonly style: TextStyle;
}

/** PDF.js Util.transform's affine-matrix multiplication, kept DOM-free for Node tests. */
function transform(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): [number, number, number, number, number, number] {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = Array.from(left);
  const [g = 0, h = 0, i = 0, j = 0, k = 0, l = 0] = Array.from(right);

  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}

/** Infer the style flags commonly encoded in embedded PDF font names. */
export function classifyFontStyle(fontName: string): {
  readonly bold: boolean;
  readonly italic: boolean;
} {
  return {
    bold: /bold|black|heavy|semibold|[6-9]00/i.test(fontName),
    italic: /italic|oblique/i.test(fontName),
  };
}

function boundingBox(points: readonly PdfPt[]): PdfRect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  };
}

/** Extract the text items for one page into the PDF-point space used by edits. */
export async function extractTextRuns(
  page: PDFPageProxy,
  pageIndex: number,
): Promise<TextRun[]> {
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  const runs: TextRun[] = [];

  for (const item of content.items) {
    if (!('str' in item) || item.str.trim() === '' || item.width === 0) continue;

    const matrix = transform(viewport.transform, item.transform);
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = matrix;
    const horizontalScale = Math.hypot(a, b);
    const verticalScale = Math.hypot(c, d);
    if (horizontalScale === 0 || verticalScale === 0) continue;

    // PDF.js reports item width/height in device space. Divide by the matrix
    // scale before applying the matrix so those dimensions are not scaled twice.
    const localWidth = item.width / horizontalScale;
    const localHeight = item.height / verticalScale;
    const apply = (x: number, y: number): ViewportPt => ({
      x: a * x + c * y + e,
      y: b * x + d * y + f,
    });
    const corners = [
      apply(0, 0),
      apply(localWidth, 0),
      apply(0, localHeight),
      apply(localWidth, localHeight),
    ].map((point) => viewportToPdf(viewport, point));

    const fontName = content.styles[item.fontName]?.fontFamily ?? item.fontName;
    runs.push({
      pageIndex,
      text: item.str,
      rect: boundingBox(corners),
      style: {
        fontName,
        fontSizePt: verticalScale,
        ...classifyFontStyle(fontName),
        // PDF.js text content does not expose fill color reliably.
        color: { r: 0, g: 0, b: 0 },
      },
    });
  }

  return runs;
}

/**
 * Resolve a PDF-point tap to the smallest containing run. If equal-area runs
 * overlap, the later item wins because it is topmost in PDF paint order.
 */
export function hitTestRun(
  runs: readonly TextRun[],
  point: PdfPt,
): TextRun | undefined {
  let match: TextRun | undefined;
  let matchArea = Number.POSITIVE_INFINITY;

  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (!run) continue;

    const { x, y, w, h } = run.rect;
    const contains =
      point.x >= x &&
      point.x <= x + w &&
      point.y >= y &&
      point.y <= y + h;
    const area = w * h;

    if (contains && area < matchArea) {
      match = run;
      matchArea = area;
    }
  }

  return match;
}
