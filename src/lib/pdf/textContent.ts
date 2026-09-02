import type { PDFPageProxy } from 'pdfjs-dist';
import type { PdfRect, TextAlignment, TextStyle } from '@/lib/export/types';
import { viewportToPdf } from '@/lib/export/coordinates';
import type { PdfPt, ViewportPt } from '@/lib/export/coordinates';
import { registerPdfJsFontReference } from '@/lib/export/embeddedFont';

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
  readonly align?: TextAlignment;
  readonly alignLeftPt?: number;
  readonly alignWidthPt?: number;
}

export interface TextBlock {
  readonly pageIndex: number;
  readonly text: string;
  readonly rect: PdfRect;
  readonly topBaselineY: number;
  readonly lineHeightPt: number;
  readonly style: TextStyle;
  readonly lines: readonly TextLine[];
  readonly align?: TextAlignment;
  readonly alignLeftPt?: number;
  readonly alignWidthPt?: number;
}

export type FontFamilyClass = 'serif' | 'sans' | 'mono';

const WORD_SYMBOL_BULLET = '\uF0B7';
const STANDARD_BULLET = '\u2022';

/** Reduce arbitrary PDF font names to the three families both renderers support. */
export function classifyFontFamily(fontName: string): FontFamilyClass {
  if (/sans[-_\s]*serif/i.test(fontName)) return 'sans';
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

/** Infer a line's alignment against the horizontal content bounds of its page. */
export function detectTextAlignment(
  rect: PdfRect,
  contentLeft: number,
  contentRight: number,
  fontSizePt: number,
): TextAlignment {
  const contentWidth = Math.max(0, contentRight - contentLeft);
  const leftGap = Math.max(0, rect.x - contentLeft);
  const rightGap = Math.max(0, contentRight - (rect.x + rect.w));
  const tolerance = Math.max(1, fontSizePt);
  // A cover-page heading can nearly span the widest text on the page; a small,
  // balanced inset is still meaningful alignment evidence.
  const meaningfulGap = Math.max(1.5, fontSizePt * 0.12);

  if (
    leftGap >= meaningfulGap &&
    rightGap >= meaningfulGap &&
    Math.abs(leftGap - rightGap) <= tolerance
  ) {
    return 'center';
  }
  if (
    rightGap <= tolerance &&
    leftGap >= Math.max(fontSizePt * 2, contentWidth * 0.2)
  ) {
    return 'right';
  }
  return 'left';
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

  const contentBounds = new Map<number, { left: number; right: number }>();
  for (const run of runs) {
    const existing = contentBounds.get(run.pageIndex);
    const right = run.rect.x + run.rect.w;
    if (existing) {
      existing.left = Math.min(existing.left, run.rect.x);
      existing.right = Math.max(existing.right, right);
    } else {
      contentBounds.set(run.pageIndex, { left: run.rect.x, right });
    }
  }

  return lines.map((line) => {
    const bounds = contentBounds.get(line.pageIndex) ?? {
      left: line.rect.x,
      right: line.rect.x + line.rect.w,
    };
    return {
      ...line,
      align: detectTextAlignment(
        line.rect,
        bounds.left,
        bounds.right,
        line.style.fontSizePt,
      ),
      alignLeftPt: bounds.left,
      alignWidthPt: Math.max(0, bounds.right - bounds.left),
    };
  }).sort(
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

  const bulletLike =
    previous.runs[0]?.text.trim() === STANDARD_BULLET &&
    line.runs[0]?.text.trim() === STANDARD_BULLET;
  const paragraphLike =
    previous.text.length >= 24 ||
    line.text.length >= 24 ||
    previous.runs.length >= 3 ||
    line.runs.length >= 3 ||
    bulletLike;
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
    const commonAlign = lines.every((line) => line.align === lines[0]?.align)
      ? (lines[0]?.align ?? 'left')
      : 'left';
    return {
      pageIndex: lines[0]?.pageIndex ?? 0,
      text: lines.map((line) => line.text).join('\n'),
      rect: unionRects(lines.map((line) => line.rect)),
      topBaselineY: Math.max(...lines.map((line) => line.baselineY)),
      lineHeightPt: median(gaps) || style.fontSizePt * 1.2,
      style,
      lines,
      align: commonAlign,
      alignLeftPt: lines[0]?.alignLeftPt,
      alignWidthPt: lines[0]?.alignWidthPt,
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

/** Read weight/slant straight from an embedded sfnt (TrueType/OpenType) font program. */
export function fontStyleFromProgram(
  data: Uint8Array | undefined,
): { readonly bold: boolean; readonly italic: boolean } | null {
  if (!data || data.length < 12) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numTables = view.getUint16(4);
  if (numTables === 0 || numTables > 64) return null;

  let os2Offset: number | null = null;
  let headOffset: number | null = null;
  for (let index = 0; index < numTables; index += 1) {
    const recordOffset = 12 + index * 16;
    if (recordOffset + 16 > data.length) return null;

    const tag = String.fromCharCode(
      data[recordOffset] ?? 0,
      data[recordOffset + 1] ?? 0,
      data[recordOffset + 2] ?? 0,
      data[recordOffset + 3] ?? 0,
    );
    const tableOffset = view.getUint32(recordOffset + 8);
    if (tag === 'OS/2') os2Offset = tableOffset;
    else if (tag === 'head') headOffset = tableOffset;
  }
  if (os2Offset === null && headOffset === null) return null;

  let bold = false;
  let italic = false;
  if (os2Offset !== null && os2Offset + 6 <= data.length) {
    bold = view.getUint16(os2Offset + 4) >= 600;
  }
  if (headOffset !== null && headOffset + 46 <= data.length) {
    const macStyle = view.getUint16(headOffset + 44);
    bold ||= (macStyle & 0x1) !== 0;
    italic = (macStyle & 0x2) !== 0;
  }
  return { bold, italic };
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
  const fontRefs = new Set(
    content.items.flatMap((item) => ('fontName' in item ? [item.fontName] : [])),
  );
  if ([...fontRefs].some((fontRef) => !page.commonObjs.has(fontRef))) {
    // Text extraction does not always hydrate the public font objects. The
    // operator list does, and is cached by pdf.js for the page render itself.
    await page.getOperatorList();
  }
  const viewport = page.getViewport({ scale: 1, rotation: 0 });
  const runs: TextRun[] = [];

  for (const item of content.items) {
    if (!('str' in item) || item.str.trim() === '' || item.width === 0) continue;
    const isWordSymbolBullet = item.str.trim() === WORD_SYMBOL_BULLET;

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

    const fontRef = item.fontName;
    const fontName = content.styles[fontRef]?.fontFamily ?? fontRef;
    const fontObject = page.commonObjs.has(fontRef)
      ? page.commonObjs.get(fontRef)
      : undefined;
    if (fontObject) registerPdfJsFontReference(fontRef, fontObject);
    const weightSource = typeof fontObject?.name === 'string' && fontObject.name.trim() !== ''
      ? fontObject.name
      : fontName;
    const nameStyle = classifyFontStyle(weightSource);
    const programStyle = fontStyleFromProgram(fontObject?.data as Uint8Array | undefined);
    runs.push({
      pageIndex,
      // Word maps Symbol's 0xB7 bullet into this private-use character. It is
      // valid only with that embedded Symbol font, so normalize it before any
      // editor path can redraw it as an unknown-glyph box.
      text: isWordSymbolBullet ? STANDARD_BULLET : item.str,
      rect: boundingBox(corners),
      style: {
        fontName,
        fontSizePt: verticalScale,
        bold: nameStyle.bold || (programStyle?.bold ?? false),
        italic: nameStyle.italic || (programStyle?.italic ?? false),
        // PDF.js text content does not expose fill color reliably.
        color: { r: 0, g: 0, b: 0 },
        fontRef: isWordSymbolBullet ? undefined : fontRef,
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
