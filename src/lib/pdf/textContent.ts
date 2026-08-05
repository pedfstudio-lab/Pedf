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

export interface TextLine {
  readonly pageIndex: number;
  readonly text: string;
  readonly rect: PdfRect;
  readonly baselineY: number;
  readonly style: TextStyle;
  readonly runs: readonly TextRun[];
}

export interface TextBlock {
  readonly pageIndex: number;
  readonly text: string;
  readonly rect: PdfRect;
  readonly topBaselineY: number;
  readonly lineHeightPt: number;
  readonly style: TextStyle;
  readonly lines: readonly TextLine[];
}

export type FontFamilyClass = 'serif' | 'sans' | 'mono';

/** Reduce arbitrary PDF font names to the three families both renderers support. */
export function classifyFontFamily(fontName: string): FontFamilyClass {
  if (/times|georgia|serif|cambria|garamond|minion|book[-_\s]*antiqua|palatino|baskerville|bodoni|constantia|merriweather/i.test(fontName)) return 'serif';
  if (/courier|mono|consolas/i.test(fontName)) return 'mono';
  return 'sans';
}

function unionRects(rects: readonly PdfRect[]): PdfRect {
  const first = rects[0];
  if (!first) return { x: 0, y: 0, w: 0, h: 0 };

  let minX = first.x;
  let minY = first.y;
  let maxX = first.x + first.w;
  let maxY = first.y + first.h;
  for (const rect of rects.slice(1)) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function representativeStyle(runs: readonly TextRun[]): TextStyle {
  return runs.reduce((best, run) => (
    run.text.trim().length > best.text.trim().length ? run : best
  )).style;
}

function lineText(runs: readonly TextRun[]): string {
  const [first, ...rest] = runs;
  if (!first) return '';

  let text = first.text.trim();
  let previous = first;
  for (const run of rest) {
    const part = run.text.trim();
    if (!part) continue;
    const gap = run.rect.x - (previous.rect.x + previous.rect.w);
    const spaceThreshold = Math.max(
      0.75,
      Math.min(previous.style.fontSizePt, run.style.fontSizePt) * 0.08,
    );
    const punctuation = /^[,.;:!?%)}\]]/.test(part) || '([{/'.includes(text.at(-1) ?? '');
    if (gap > spaceThreshold && !punctuation) text += ' ';
    text += part;
    previous = run;
  }
  return text;
}

function makeLine(runs: readonly TextRun[]): TextLine {
  const style = representativeStyle(runs);
  return {
    pageIndex: runs[0]?.pageIndex ?? 0,
    text: lineText(runs),
    rect: unionRects(runs.map((run) => run.rect)),
    baselineY: runs.reduce((sum, run) => sum + run.rect.y, 0) / Math.max(1, runs.length),
    style,
    runs,
  };
}

function isStandaloneNumber(text: string): boolean {
  return /^[\d.,/-]{1,6}$/.test(text.trim());
}

/** Merge PDF.js fragments first by baseline and then by natural horizontal gaps. */
export function mergeRunsIntoLines(runs: readonly TextRun[]): TextLine[] {
  const rows: Array<{ pageIndex: number; baselineY: number; runs: TextRun[] }> = [];
  const sorted = [...runs].sort(
    (left, right) =>
      left.pageIndex - right.pageIndex ||
      right.rect.y - left.rect.y ||
      left.rect.x - right.rect.x,
  );

  for (const run of sorted) {
    const tolerance = Math.max(1.5, run.style.fontSizePt * 0.18);
    const row = rows
      .filter((candidate) => candidate.pageIndex === run.pageIndex)
      .sort(
        (left, right) =>
          Math.abs(left.baselineY - run.rect.y) - Math.abs(right.baselineY - run.rect.y),
      )
      .find((candidate) => Math.abs(candidate.baselineY - run.rect.y) <= tolerance);
    if (row) {
      row.runs.push(run);
      row.baselineY = row.runs.reduce((sum, item) => sum + item.rect.y, 0) / row.runs.length;
    } else {
      rows.push({ pageIndex: run.pageIndex, baselineY: run.rect.y, runs: [run] });
    }
  }

  const lines: TextLine[] = [];
  for (const row of rows) {
    const ordered = row.runs.sort((left, right) => left.rect.x - right.rect.x);
    let segment: TextRun[] = [];
    for (const run of ordered) {
      const previous = segment.at(-1);
      const gap = previous ? run.rect.x - (previous.rect.x + previous.rect.w) : 0;
      const columnGap = Math.max(
        18,
        Math.max(previous?.style.fontSizePt ?? 0, run.style.fontSizePt) * 1.75,
      );
      const separateNumbers = previous &&
        isStandaloneNumber(previous.text) &&
        isStandaloneNumber(run.text) &&
        gap > Math.max(3, run.style.fontSizePt * 0.4);
      if (previous && (gap > columnGap || separateNumbers)) {
        lines.push(makeLine(segment));
        segment = [];
      }
      segment.push(run);
    }
    if (segment.length > 0) lines.push(makeLine(segment));
  }

  return lines.sort(
    (left, right) =>
      left.pageIndex - right.pageIndex ||
      right.baselineY - left.baselineY ||
      left.rect.x - right.rect.x,
  );
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[middle] ?? 0;
  return ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

function canJoinBlock(lines: readonly TextLine[], line: TextLine): boolean {
  const previous = lines.at(-1);
  if (!previous || previous.pageIndex !== line.pageIndex) return false;
  if (isStandaloneNumber(previous.text) || isStandaloneNumber(line.text)) return false;

  const verticalGap = previous.baselineY - line.baselineY;
  const size = Math.max(previous.style.fontSizePt, line.style.fontSizePt);
  if (verticalGap <= 0.5 || verticalGap > size * 1.85) return false;
  if (Math.abs(previous.style.fontSizePt - line.style.fontSizePt) > Math.max(1.5, size * 0.22)) {
    return false;
  }
  if (
    classifyFontFamily(previous.style.fontName) !== classifyFontFamily(line.style.fontName) ||
    previous.style.bold !== line.style.bold ||
    previous.style.italic !== line.style.italic
  ) {
    return false;
  }

  const paragraphLike =
    previous.text.length >= 24 ||
    line.text.length >= 24 ||
    previous.runs.length >= 3 ||
    line.runs.length >= 3;
  if (!paragraphLike) return false;

  const startDelta = Math.abs(previous.rect.x - line.rect.x);
  const overlap = Math.max(
    0,
    Math.min(previous.rect.x + previous.rect.w, line.rect.x + line.rect.w) -
      Math.max(previous.rect.x, line.rect.x),
  );
  const overlapRatio = overlap / Math.max(1, Math.min(previous.rect.w, line.rect.w));
  if (startDelta > Math.max(9, size) && overlapRatio < 0.7) return false;

  if (lines.length >= 2) {
    const gaps = lines.slice(1).map((item, index) => (
      (lines[index]?.baselineY ?? item.baselineY) - item.baselineY
    ));
    const expected = median(gaps);
    if (Math.abs(verticalGap - expected) > Math.max(2, expected * 0.35)) return false;
  }
  return true;
}

/** Group natural wrapped lines into editable paragraph blocks while keeping short fields standalone. */
export function groupRunsIntoBlocks(runs: readonly TextRun[]): TextBlock[] {
  const lineGroups: TextLine[][] = [];
  for (const line of mergeRunsIntoLines(runs)) {
    const candidates = lineGroups
      .filter((group) => canJoinBlock(group, line))
      .sort((left, right) => {
        const leftLast = left.at(-1);
        const rightLast = right.at(-1);
        return (
          Math.abs((leftLast?.rect.x ?? 0) - line.rect.x) -
          Math.abs((rightLast?.rect.x ?? 0) - line.rect.x)
        );
      });
    const target = candidates[0];
    if (target) target.push(line);
    else lineGroups.push([line]);
  }

  return lineGroups.map((lines) => {
    const style = lines[0]?.style ?? {
      fontName: 'Helvetica',
      fontSizePt: 12,
      bold: false,
      italic: false,
      color: { r: 0, g: 0, b: 0 },
    };
    const gaps = lines.slice(1).map((line, index) => (
      (lines[index]?.baselineY ?? line.baselineY) - line.baselineY
    ));
    return {
      pageIndex: lines[0]?.pageIndex ?? 0,
      text: lines.map((line) => line.text).join('\n'),
      rect: unionRects(lines.map((line) => line.rect)),
      topBaselineY: Math.max(...lines.map((line) => line.baselineY)),
      lineHeightPt: median(gaps) || style.fontSizePt * 1.2,
      style,
      lines,
    };
  });
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
