import { OPS } from 'pdfjs-dist';
import type { PageViewport } from 'pdfjs-dist';
import { viewportToPdf } from '@/lib/export/coordinates';
import type { PdfRect } from '@/lib/export/types';
import {
  transformGraphicsPoint,
  walkOperatorListGraphicsState,
} from './images';
import type { GraphicsMatrix, OperatorListLike } from './images';
import type { TextRun } from './textContent';

export interface CoveringBox {
  readonly rect: PdfRect;
  readonly operatorIndex: number;
}

const TEXT_SHOW = new Set([
  OPS.showText,
  OPS.showSpacedText,
  OPS.nextLineShowText,
  OPS.nextLineSetSpacingShowText,
]);
const FILL = new Set([
  OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
  OPS.closeFillStroke, OPS.closeEOFillStroke,
]);
const PATH_END = new Set([OPS.stroke, OPS.closeStroke, OPS.endPath]);

function values(value: unknown): number[] | null {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const list = Array.from(value as ArrayLike<unknown>);
  return list.every((number) => typeof number === 'number' && Number.isFinite(number))
    ? list as number[]
    : null;
}

function shownGlyphs(value: unknown): string {
  if (Array.isArray(value)) return value.map(shownGlyphs).join('');
  if (!value || typeof value !== 'object') return '';
  const unicode = (value as { unicode?: unknown }).unicode;
  return typeof unicode === 'string' ? unicode : '';
}

function significant(text: string): string[] {
  return [...text].filter((character) => !/\s/u.test(character));
}

/** Match every extracted item to its last contributing text-showing operator. */
export function mapTextItemsToOperators(
  items: readonly unknown[],
  operatorList: OperatorListLike,
): number[] | null {
  const shown: Array<{ character: string; index: number }> = [];
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    if (!TEXT_SHOW.has(operatorList.fnArray[index] ?? -1)) continue;
    for (const character of significant(shownGlyphs(operatorList.argsArray[index]))) {
      shown.push({ character, index });
    }
  }

  const mapped: number[] = [];
  let position = 0;
  for (const item of items) {
    const text = item && typeof item === 'object' && 'str' in item
      ? (item as { str: unknown }).str
      : undefined;
    if (typeof text !== 'string') {
      mapped.push(-1);
      continue;
    }
    let lastIndex = -1;
    for (const character of significant(text)) {
      const next = shown[position++];
      if (!next || next.character !== character) return null;
      lastIndex = next.index;
    }
    mapped.push(lastIndex);
  }
  // PDF.js may include a later annotation appearance in the operator list
  // while getTextContent omits it. A trailing suffix cannot change any item
  // already matched in order; a mismatch in the middle still fails closed.
  return mapped;
}

function rectanglePoints(
  rawArgs: readonly unknown[],
): Array<{ x: number; y: number }> | null {
  const operations = values(rawArgs[0]);
  const coordinates = values(rawArgs[1]);
  if (!operations || !coordinates) return null;
  if (operations.length === 1 && operations[0] === OPS.rectangle && coordinates.length === 4) {
    const [x = 0, y = 0, w = 0, h = 0] = coordinates;
    return [
      { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
    ];
  }
  if (
    operations.length === 5 &&
    operations[0] === OPS.moveTo &&
    operations.slice(1, 4).every((operation) => operation === OPS.lineTo) &&
    operations[4] === OPS.closePath &&
    coordinates.length === 8
  ) {
    return [0, 2, 4, 6].map((offset) => ({
      x: coordinates[offset] ?? 0,
      y: coordinates[offset + 1] ?? 0,
    }));
  }
  return null;
}

function axisAlignedBox(
  rawArgs: readonly unknown[],
  matrix: GraphicsMatrix,
  viewport: PageViewport,
): PdfRect | null {
  const points = rectanglePoints(rawArgs)?.map(({ x, y }) => (
    viewportToPdf(viewport, transformGraphicsPoint(matrix, x, y))
  ));
  if (!points || points.length !== 4) return null;
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const bottom = Math.min(...ys);
  const top = Math.max(...ys);
  if (right - left <= 0.01 || top - bottom <= 0.01) return null;
  const tolerance = 0.02;
  const corners = new Set<string>();
  for (const point of points) {
    const leftSide = Math.abs(point.x - left) <= tolerance;
    const rightSide = Math.abs(point.x - right) <= tolerance;
    const bottomSide = Math.abs(point.y - bottom) <= tolerance;
    const topSide = Math.abs(point.y - top) <= tolerance;
    if ((!leftSide && !rightSide) || (!bottomSide && !topSide)) return null;
    corners.add(`${leftSide ? 'L' : 'R'}${bottomSide ? 'B' : 'T'}`);
  }
  if (corners.size !== 4) return null;
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}

interface CoverState {
  alpha: number;
  normalBlend: boolean;
  softMask: boolean;
  clipped: boolean;
}

function applyGState(state: CoverState, rawArgs: readonly unknown[]): CoverState {
  const entries = Array.isArray(rawArgs[0]) ? rawArgs[0] : [];
  const next = { ...state };
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    const [key, value] = entry;
    if (key === 'ca') {
      next.alpha = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    } else if (key === 'BM') {
      next.normalBlend = typeof value === 'string' &&
        ['normal', 'source-over'].includes(value.toLowerCase());
    } else if (key === 'SMask') {
      next.softMask = value !== null && value !== false && value !== 'None';
    }
  }
  return next;
}

/** Opaque single-rectangle fills, in the same PDF-point space as TextRun.rect. */
export function coveringBoxesFromOperatorList(
  operatorList: OperatorListLike,
  viewport: PageViewport,
): CoveringBox[] {
  const boxes: CoveringBox[] = [];
  const stack: CoverState[] = [];
  let state: CoverState = { alpha: 1, normalBlend: true, softMask: false, clipped: false };
  let path: PdfRect | null = null;
  let pathCount = 0;
  let pathClipped = false;

  walkOperatorListGraphicsState(operatorList, viewport, (operation, args, matrix, index) => {
    if (operation === OPS.save || operation === OPS.paintFormXObjectBegin) {
      stack.push({ ...state });
      path = null;
      pathCount = 0;
      pathClipped = false;
    } else if (operation === OPS.restore || operation === OPS.paintFormXObjectEnd) {
      state = stack.pop() ?? state;
      path = null;
      pathCount = 0;
      pathClipped = false;
    } else if (operation === OPS.setGState) {
      state = applyGState(state, args);
    } else if (operation === OPS.constructPath) {
      pathCount += 1;
      path = axisAlignedBox(args, matrix, viewport);
    } else if (operation === OPS.clip || operation === OPS.eoClip) {
      pathClipped = true;
      state = { ...state, clipped: true };
    } else if (FILL.has(operation)) {
      if (
        pathCount === 1 && path && !pathClipped && !state.clipped &&
        state.alpha >= 1 && state.normalBlend && !state.softMask
      ) boxes.push({ rect: path, operatorIndex: index });
      path = null;
      pathCount = 0;
      pathClipped = false;
    } else if (PATH_END.has(operation)) {
      path = null;
      pathCount = 0;
      pathClipped = false;
    }
  });
  return boxes;
}

function coveredDimensions(rect: PdfRect, box: PdfRect): { width: number; height: number } {
  const area = rect.w * rect.h;
  if (!Number.isFinite(area) || area <= 0) return { width: 0, height: 0 };
  const width = Math.max(0, Math.min(rect.x + rect.w, box.x + box.w) - Math.max(rect.x, box.x));
  const height = Math.max(0, Math.min(rect.y + rect.h, box.y + box.h) - Math.max(rect.y, box.y));
  return { width: width / rect.w, height: height / rect.h };
}

/** If paint-order mapping fails, keep every run on the page. */
export function dropCoveredTextRuns(
  runs: readonly TextRun[],
  itemIndexes: readonly number[],
  items: readonly unknown[],
  operatorList: OperatorListLike,
  viewport: PageViewport,
): TextRun[] {
  const mapped = mapTextItemsToOperators(items, operatorList);
  if (!mapped || mapped.length !== items.length || runs.length !== itemIndexes.length) return [...runs];
  const boxes = coveringBoxesFromOperatorList(operatorList, viewport);
  if (boxes.length === 0) return [...runs];
  return runs.filter((run, index) => {
    const paintedAt = mapped[itemIndexes[index] ?? -1] ?? -1;
    if (paintedAt < 0) return true;
    return !boxes.some((box) => {
      if (box.operatorIndex <= paintedAt) return false;
      const coverage = coveredDimensions(run.rect, box.rect);
      if (coverage.width * coverage.height >= 0.95) return true;

      // Export covers can be shorter than PDF.js's font-height box yet cover
      // the painted glyphs. Only treat that as hidden if a later redraw at the
      // same origin corroborates it; otherwise partial covers keep the text.
      if (coverage.width < 0.95 || coverage.height < 0.7) return false;
      const redraw = runs.some((later, laterIndex) => {
        if (laterIndex === index) return false;
        const laterAt = mapped[itemIndexes[laterIndex] ?? -1] ?? -1;
        const originTolerance = Math.max(1, run.style.fontSizePt * 0.15);
        return laterAt > box.operatorIndex &&
          later.pageIndex === run.pageIndex &&
          Math.abs(later.rect.x - run.rect.x) <= originTolerance &&
          Math.abs(later.rect.y - run.rect.y) <= originTolerance;
      });
      return redraw;
    });
  });
}
