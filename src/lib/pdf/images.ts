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
  /** The exact PDF.js draw behind this region, when detection retained it. */
  readonly draw?: DrawnImage;
  readonly hasText: boolean;
  readonly paragraph: boolean;
}

export interface DrawnImage {
  readonly region: ImageRegion;
  /** The part of the placed image that remains visible after page, path, and Form clipping. */
  readonly visibleRect?: PdfRect;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly objectId?: string;
  readonly kind: 'image' | 'inline' | 'mask';
}

export interface OperatorListLike {
  readonly fnArray: readonly number[];
  readonly argsArray: readonly unknown[];
}

export type GraphicsMatrix = readonly [number, number, number, number, number, number];
export type GraphicsClipRect = readonly [number, number, number, number];

export type GraphicsStateVisitor = (
  operation: number,
  args: readonly unknown[],
  transform: GraphicsMatrix,
  index: number,
  clip?: GraphicsClipRect,
) => void;

function matrix(value: unknown): GraphicsMatrix | undefined {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return undefined;
  const values = Array.from(value as ArrayLike<unknown>);
  if (values.length !== 6 || values.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    return undefined;
  }
  return values as unknown as GraphicsMatrix;
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

function clipBounds(value: unknown): GraphicsClipRect | undefined {
  const values = numberValues(value);
  if (values?.length !== 4 || values.some((item) => !Number.isFinite(item))) return undefined;
  const [firstX = 0, firstY = 0, secondX = 0, secondY = 0] = values;
  return [
    Math.min(firstX, secondX),
    Math.min(firstY, secondY),
    Math.max(firstX, secondX),
    Math.max(firstY, secondY),
  ];
}

/** PDF/canvas affine multiplication: applying `right` inside the current `left` transform. */
function multiply(left: GraphicsMatrix, right: GraphicsMatrix): GraphicsMatrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

export function transformGraphicsPoint(
  transform: GraphicsMatrix,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  return {
    x: transform[0] * x + transform[2] * y + transform[4],
    y: transform[1] * x + transform[3] * y + transform[5],
  };
}

function transformedBounds(
  bounds: GraphicsClipRect,
  transform: GraphicsMatrix,
): GraphicsClipRect {
  const [left, top, right, bottom] = bounds;
  const corners = [
    transformGraphicsPoint(transform, left, top),
    transformGraphicsPoint(transform, right, top),
    transformGraphicsPoint(transform, left, bottom),
    transformGraphicsPoint(transform, right, bottom),
  ];
  return [
    Math.min(...corners.map((corner) => corner.x)),
    Math.min(...corners.map((corner) => corner.y)),
    Math.max(...corners.map((corner) => corner.x)),
    Math.max(...corners.map((corner) => corner.y)),
  ];
}

function intersectBounds(left: GraphicsClipRect, right: GraphicsClipRect): GraphicsClipRect {
  const minX = Math.max(left[0], right[0]);
  const minY = Math.max(left[1], right[1]);
  const maxX = Math.min(left[2], right[2]);
  const maxY = Math.min(left[3], right[3]);
  return [minX, minY, Math.max(minX, maxX), Math.max(minY, maxY)];
}

function sameBounds(left: GraphicsClipRect, right: GraphicsClipRect): boolean {
  return left.every((value, index) => value === right[index]);
}

function imageBounds(transform: GraphicsMatrix): GraphicsClipRect {
  return transformedBounds([0, 0, 1, 1], transform);
}

function boundsToPdfRect(bounds: GraphicsClipRect, viewport: PageViewport): PdfRect {
  return screenRectToPdfRect(
    {
      left: bounds[0],
      top: bounds[1],
      width: bounds[2] - bounds[0],
      height: bounds[3] - bounds[1],
    },
    viewport,
    1,
  );
}

function imageRect(transform: GraphicsMatrix, viewport: PageViewport): PdfRect {
  return boundsToPdfRect(imageBounds(transform), viewport);
}

/** Walk a flattened PDF.js operator list while reproducing its graphics-state CTM. */
export function walkOperatorListGraphicsState(
  operatorList: OperatorListLike,
  viewport: PageViewport,
  visit: GraphicsStateVisitor,
): void {
  const viewportMatrix = matrix(viewport.transform);
  if (!viewportMatrix) throw new Error('PDF viewport has an invalid transform');
  let current = viewportMatrix;
  let currentClip: GraphicsClipRect = [0, 0, viewport.width, viewport.height];
  const stack: Array<{
    readonly transform: GraphicsMatrix;
    readonly clip: GraphicsClipRect;
  }> = [];
  let pathBounds: GraphicsClipRect | undefined;

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    if (operation === undefined) continue;
    const rawArgs = operatorList.argsArray[index];
    const args = Array.isArray(rawArgs) ? rawArgs : [];
    if (operation === OPS.save) {
      stack.push({ transform: current, clip: currentClip });
    } else if (operation === OPS.restore) {
      const restored = stack.pop();
      if (restored) {
        current = restored.transform;
        currentClip = restored.clip;
      }
    } else if (operation === OPS.transform) {
      const next = matrix(args);
      if (next) current = multiply(current, next);
    } else if (operation === OPS.paintFormXObjectBegin) {
      stack.push({ transform: current, clip: currentClip });
      const formMatrix = matrix(args[0]);
      if (formMatrix) current = multiply(current, formMatrix);
      const formBounds = clipBounds(args[1]);
      if (formBounds) currentClip = intersectBounds(currentClip, transformedBounds(formBounds, current));
    } else if (operation === OPS.paintFormXObjectEnd) {
      const restored = stack.pop();
      if (restored) {
        current = restored.transform;
        currentClip = restored.clip;
      }
    } else if (operation === OPS.constructPath) {
      const bounds = clipBounds(args[2]);
      pathBounds = bounds ? transformedBounds(bounds, current) : undefined;
    } else if (operation === OPS.clip || operation === OPS.eoClip) {
      if (pathBounds) currentClip = intersectBounds(currentClip, pathBounds);
      pathBounds = undefined;
    } else if (operation === OPS.endPath) {
      pathBounds = undefined;
    }
    visit(operation, args, current, index, currentClip);
  }
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
  const regions: ImageRegion[] = [];
  for (const draw of imageDrawsFromOperatorList(operatorList, viewport, pageIndex)) {
    if (!regions.some((region) => sameRect(region.rect, draw.region.rect))) regions.push(draw.region);
  }
  return regions;
}

/** The same graphics-state walk as image detection, retaining object ids and true drawn axis lengths. */
export function imageDrawsFromOperatorList(
  operatorList: OperatorListLike,
  viewport: PageViewport,
  pageIndex: number,
): DrawnImage[] {
  const draws: DrawnImage[] = [];

  const add = (
    transform: GraphicsMatrix,
    clip: GraphicsClipRect,
    kind: DrawnImage['kind'],
    objectId?: unknown,
  ) => {
    const placedBounds = imageBounds(transform);
    const rect = imageRect(transform, viewport);
    if (rect.w <= 0.1 || rect.h <= 0.1) return;
    const visibleBounds = intersectBounds(placedBounds, clip);
    const visible = sameBounds(placedBounds, visibleBounds)
      ? rect
      : boundsToPdfRect(visibleBounds, viewport);
    const visibleRect = visible.w > 0.1 && visible.h > 0.1 ? visible : undefined;
    draws.push({
      region: { pageIndex, rect },
      ...(visibleRect ? { visibleRect } : {}),
      widthPt: Math.hypot(transform[0], transform[1]),
      heightPt: Math.hypot(transform[2], transform[3]),
      ...(typeof objectId === 'string' ? { objectId } : {}),
      kind,
    });
  };
  const addNested = (
    current: GraphicsMatrix,
    clip: GraphicsClipRect,
    nested: unknown,
    kind: DrawnImage['kind'],
    objectId?: unknown,
  ) => {
    const nestedMatrix = matrix(nested);
    if (nestedMatrix) add(multiply(current, nestedMatrix), clip, kind, objectId);
  };

  walkOperatorListGraphicsState(operatorList, viewport, (operation, args, current, _index, clip) => {
    if (!clip) return;
    if (operation === OPS.paintImageXObject) {
      add(current, clip, 'image', args[0]);
    } else if (operation === OPS.paintInlineImageXObject) {
      add(current, clip, 'inline');
    } else if (operation === OPS.paintImageMaskXObject) {
      add(current, clip, 'mask', args[0]);
    } else if (operation === OPS.paintImageXObjectRepeat) {
      const scaleX = Number(args[1]);
      const scaleY = Number(args[2]);
      const values = numberValues(args[3]);
      if (Number.isFinite(scaleX) && Number.isFinite(scaleY) && values) {
        for (let offset = 0; offset + 1 < values.length; offset += 2) {
          addNested(
            current,
            clip,
            [scaleX, 0, 0, scaleY, values[offset] ?? 0, values[offset + 1] ?? 0],
            'image',
            args[0],
          );
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
          addNested(
            current,
            clip,
            [
              scaleX,
              skewY,
              skewX,
              scaleY,
              values[offset] ?? 0,
              values[offset + 1] ?? 0,
            ],
            'mask',
            args[0],
          );
        }
      }
    } else if (operation === OPS.paintInlineImageXObjectGroup) {
      const entries = Array.isArray(args[1]) ? args[1] : [];
      for (const entry of entries) {
        addNested(current, clip, (entry as { transform?: unknown }).transform, 'inline');
      }
    } else if (operation === OPS.paintImageMaskXObjectGroup) {
      const entries = Array.isArray(args[0]) ? args[0] : [];
      for (const entry of entries) {
        addNested(current, clip, (entry as { transform?: unknown }).transform, 'mask');
      }
    }
  });
  return draws;
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
  const [operatorList, textRuns] = await Promise.all([
    page.getOperatorList(),
    extractTextRuns(page, pageIndex),
  ]);
  const draws = imageDrawsFromOperatorList(
    operatorList,
    page.getViewport({ scale: 1 }),
    pageIndex,
  );
  const visibleDraws = draws.filter((draw): draw is DrawnImage & { visibleRect: PdfRect } => (
    draw.visibleRect !== undefined
  ));
  const uniqueDraws = visibleDraws.filter((draw, index) => (
    visibleDraws.findIndex((candidate) => sameRect(candidate.visibleRect, draw.visibleRect)) === index
  ));
  return filterTextBackedRegions(uniqueDraws.map((draw) => ({
    pageIndex: draw.region.pageIndex,
    rect: draw.visibleRect,
  })), textRuns)
    .map((signals, index) => ({ ...signals, draw: uniqueDraws[index] }));
}
