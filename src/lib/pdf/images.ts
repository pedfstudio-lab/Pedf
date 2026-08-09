import { OPS } from 'pdfjs-dist';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { screenRectToPdfRect } from '@/lib/export/coordinates';
import type { PdfRect } from '@/lib/export/types';
import { extractTextRuns } from './textContent';
import type { TextRun } from './textContent';

/** A run must be mostly inside an image region before it counts as text on that image. */
export const TEXT_RUN_INSIDE_RATIO = 0.6;

/** High enough that ordinary photo titles/captions do not count as running text. */
export const PARAGRAPH_TEXT = 160;

export interface ImageRegion {
  readonly pageIndex: number;
  readonly rect: PdfRect;
}

export interface ImageRegionTextSignals {
  readonly region: ImageRegion;
  readonly hasText: boolean;
  readonly paragraph: boolean;
}

export interface OperatorListLike {
  readonly fnArray: readonly number[];
  readonly argsArray: readonly unknown[];
}

type Matrix = readonly [number, number, number, number, number, number];

function matrix(value: unknown): Matrix | undefined {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return undefined;
  const values = Array.from(value as ArrayLike<unknown>);
  if (values.length !== 6 || values.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    return undefined;
  }
  return values as unknown as Matrix;
}

function numberValues(value: unknown): number[] | undefined {
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'number') ? value as number[] : undefined;
  }
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<number>);
  }
  return undefined;
}

/** PDF/canvas affine multiplication: applying `right` inside the current `left` transform. */
function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function point(transform: Matrix, x: number, y: number): { readonly x: number; readonly y: number } {
  return {
    x: transform[0] * x + transform[2] * y + transform[4],
    y: transform[1] * x + transform[3] * y + transform[5],
  };
}

function imageRect(transform: Matrix, viewport: PageViewport): PdfRect {
  const corners = [
    point(transform, 0, 0),
    point(transform, 1, 0),
    point(transform, 0, 1),
    point(transform, 1, 1),
  ];
  const left = Math.min(...corners.map((corner) => corner.x));
  const top = Math.min(...corners.map((corner) => corner.y));
  const right = Math.max(...corners.map((corner) => corner.x));
  const bottom = Math.max(...corners.map((corner) => corner.y));
  return screenRectToPdfRect(
    { left, top, width: right - left, height: bottom - top },
    viewport,
    1,
  );
}

function sameRect(left: PdfRect, right: PdfRect): boolean {
  const epsilon = 0.01;
  return (
    Math.abs(left.x - right.x) <= epsilon &&
    Math.abs(left.y - right.y) <= epsilon &&
    Math.abs(left.w - right.w) <= epsilon &&
    Math.abs(left.h - right.h) <= epsilon
  );
}

function intersectionArea(left: PdfRect, right: PdfRect): number {
  const width = Math.max(
    0,
    Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y),
  );
  return width * height;
}

/** Classify the extractable text substantially contained by each detected image rectangle. */
export function filterTextBackedRegions(
  regions: readonly ImageRegion[],
  textRuns: readonly TextRun[],
  paragraphText = PARAGRAPH_TEXT,
  insideRatio = TEXT_RUN_INSIDE_RATIO,
): ImageRegionTextSignals[] {
  if (!Number.isFinite(paragraphText) || paragraphText < 0) {
    throw new RangeError('Paragraph text threshold must be a non-negative finite number.');
  }
  if (!Number.isFinite(insideRatio) || insideRatio < 0 || insideRatio > 1) {
    throw new RangeError('Text-run inside ratio must be between 0 and 1.');
  }

  return regions.map((region) => {
    let characterCount = 0;
    let hasText = false;
    for (const run of textRuns) {
      const text = run.text.trim();
      if (run.pageIndex !== region.pageIndex || text.length === 0) continue;
      const runArea = run.rect.w * run.rect.h;
      if (!Number.isFinite(runArea) || runArea <= 0) continue;
      if (intersectionArea(region.rect, run.rect) / runArea < insideRatio) continue;
      hasText = true;
      characterCount += text.length;
    }
    return {
      region,
      hasText,
      paragraph: characterCount > paragraphText,
    };
  });
}

/**
 * Walk a flattened PDF.js operator list while reproducing its graphics-state CTM.
 * Clipped, masked, repeated, or tiled images intentionally return bounding rectangles only.
 */
export function imageRegionsFromOperatorList(
  operatorList: OperatorListLike,
  viewport: PageViewport,
  pageIndex: number,
): ImageRegion[] {
  const viewportMatrix = matrix(viewport.transform);
  if (!viewportMatrix) throw new Error('PDF viewport has an invalid transform');
  let current = viewportMatrix;
  const stack: Matrix[] = [];
  const regions: ImageRegion[] = [];

  const add = (transform: Matrix) => {
    const rect = imageRect(transform, viewport);
    if (rect.w <= 0.1 || rect.h <= 0.1) return;
    if (!regions.some((region) => sameRect(region.rect, rect))) {
      regions.push({ pageIndex, rect });
    }
  };
  const addNested = (nested: unknown) => {
    const nestedMatrix = matrix(nested);
    if (nestedMatrix) add(multiply(current, nestedMatrix));
  };

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const rawArgs = operatorList.argsArray[index];
    const args = Array.isArray(rawArgs) ? rawArgs : [];
    if (operation === OPS.save) {
      stack.push(current);
    } else if (operation === OPS.restore) {
      current = stack.pop() ?? current;
    } else if (operation === OPS.transform) {
      const next = matrix(args);
      if (next) current = multiply(current, next);
    } else if (operation === OPS.paintFormXObjectBegin) {
      stack.push(current);
      const formMatrix = matrix(args[0]);
      if (formMatrix) current = multiply(current, formMatrix);
    } else if (operation === OPS.paintFormXObjectEnd) {
      current = stack.pop() ?? current;
    } else if (
      operation === OPS.paintImageXObject ||
      operation === OPS.paintInlineImageXObject ||
      operation === OPS.paintImageMaskXObject
    ) {
      add(current);
    } else if (operation === OPS.paintImageXObjectRepeat) {
      const scaleX = Number(args[1]);
      const scaleY = Number(args[2]);
      const values = numberValues(args[3]);
      if (Number.isFinite(scaleX) && Number.isFinite(scaleY) && values) {
        for (let offset = 0; offset + 1 < values.length; offset += 2) {
          addNested([scaleX, 0, 0, scaleY, values[offset] ?? 0, values[offset + 1] ?? 0]);
        }
      }
    } else if (operation === OPS.paintImageMaskXObjectRepeat) {
      const scaleX = Number(args[1]);
      const skewX = Number(args[2]);
      const skewY = Number(args[3]);
      const scaleY = Number(args[4]);
      const values = numberValues(args[5]);
      if ([scaleX, skewX, skewY, scaleY].every(Number.isFinite) && values) {
        for (let offset = 0; offset + 1 < values.length; offset += 2) {
          addNested([
            scaleX,
            skewY,
            skewX,
            scaleY,
            values[offset] ?? 0,
            values[offset + 1] ?? 0,
          ]);
        }
      }
    } else if (operation === OPS.paintInlineImageXObjectGroup) {
      const entries = Array.isArray(args[1]) ? args[1] : [];
      for (const entry of entries) addNested((entry as { transform?: unknown }).transform);
    } else if (operation === OPS.paintImageMaskXObjectGroup) {
      const entries = Array.isArray(args[0]) ? args[0] : [];
      for (const entry of entries) addNested((entry as { transform?: unknown }).transform);
    }
  }
  return regions;
}

export async function detectImages(page: PDFPageProxy, pageIndex: number): Promise<ImageRegion[]> {
  const operatorList = await page.getOperatorList();
  const viewport = page.getViewport({ scale: 1 });
  return imageRegionsFromOperatorList(operatorList, viewport, pageIndex);
}

/** Fetch raw image regions and the text signals used by the browser-side richness decision. */
export async function detectImageCandidates(
  page: PDFPageProxy,
  pageIndex: number,
): Promise<ImageRegionTextSignals[]> {
  const [regions, textRuns] = await Promise.all([
    detectImages(page, pageIndex),
    extractTextRuns(page, pageIndex),
  ]);
  return filterTextBackedRegions(regions, textRuns);
}
