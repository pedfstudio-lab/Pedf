import { OPS } from 'pdfjs-dist';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import { screenRectToPdfRect } from '@/lib/export/coordinates';
import {
  imageRegionsFromOperatorList,
  transformGraphicsPoint,
  walkOperatorListGraphicsState,
} from './images';
import type { GraphicsMatrix, ImageRegion, OperatorListLike } from './images';

const MIN_MARKER_SIZE_PT = 1;
const MAX_MARKER_SIZE_PT = 7;
const MIN_MARKER_ASPECT = 0.65;
const MAX_MARKER_ASPECT = 1.55;

interface PathPoint {
  readonly x: number;
  readonly y: number;
}

export interface PageGraphicRegions {
  readonly imageRegions: readonly ImageRegion[];
  readonly shapeMarkerRegions: readonly ImageRegion[];
}

function numericValues(value: unknown): number[] | undefined {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return undefined;
  const values = Array.from(value as ArrayLike<unknown>);
  return values.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ? values as number[]
    : undefined;
}

function pathPoints(rawArgs: readonly unknown[], transform: GraphicsMatrix): PathPoint[] {
  const operations = numericValues(rawArgs[0]);
  const coordinates = numericValues(rawArgs[1]);
  if (!operations || !coordinates) return [];

  const points: PathPoint[] = [];
  let cursor = 0;
  const add = (x: number | undefined, y: number | undefined) => {
    if (x === undefined || y === undefined) return false;
    points.push(transformGraphicsPoint(transform, x, y));
    return true;
  };

  for (const operation of operations) {
    if (operation === OPS.moveTo || operation === OPS.lineTo) {
      if (!add(coordinates[cursor], coordinates[cursor + 1])) return [];
      cursor += 2;
    } else if (operation === OPS.curveTo) {
      for (let offset = 0; offset < 6; offset += 2) {
        if (!add(coordinates[cursor + offset], coordinates[cursor + offset + 1])) return [];
      }
      cursor += 6;
    } else if (operation === OPS.curveTo2 || operation === OPS.curveTo3) {
      for (let offset = 0; offset < 4; offset += 2) {
        if (!add(coordinates[cursor + offset], coordinates[cursor + offset + 1])) return [];
      }
      cursor += 4;
    } else if (operation === OPS.rectangle) {
      const x = coordinates[cursor];
      const y = coordinates[cursor + 1];
      const width = coordinates[cursor + 2];
      const height = coordinates[cursor + 3];
      if (x === undefined || y === undefined || width === undefined || height === undefined) return [];
      add(x, y);
      add(x + width, y);
      add(x + width, y + height);
      add(x, y + height);
      cursor += 4;
    } else if (operation !== OPS.closePath) {
      return [];
    }
  }
  return points;
}

function regionFromPoints(
  points: readonly PathPoint[],
  viewport: PageViewport,
  pageIndex: number,
): ImageRegion | undefined {
  if (points.length === 0) return undefined;
  const left = Math.min(...points.map((entry) => entry.x));
  const top = Math.min(...points.map((entry) => entry.y));
  const right = Math.max(...points.map((entry) => entry.x));
  const bottom = Math.max(...points.map((entry) => entry.y));
  const rect = screenRectToPdfRect(
    { left, top, width: right - left, height: bottom - top },
    viewport,
    1,
  );
  const longSide = Math.max(rect.w, rect.h);
  const aspect = rect.w / Math.max(0.001, rect.h);
  if (
    longSide < MIN_MARKER_SIZE_PT ||
    longSide > MAX_MARKER_SIZE_PT ||
    aspect < MIN_MARKER_ASPECT ||
    aspect > MAX_MARKER_ASPECT
  ) {
    return undefined;
  }
  return { pageIndex, rect };
}

/** Find small filled path bounds in the same PDF-point coordinate space as image regions. */
export function shapeMarkerRegionsFromOperatorList(
  operatorList: OperatorListLike,
  viewport: PageViewport,
  pageIndex: number,
): ImageRegion[] {
  const regions: ImageRegion[] = [];
  let pendingPoints: PathPoint[] | undefined;
  let clipping = false;

  walkOperatorListGraphicsState(operatorList, viewport, (operation, args, transform) => {
    if (operation === OPS.constructPath) {
      pendingPoints = pathPoints(args, transform);
      clipping = false;
    } else if (operation === OPS.clip || operation === OPS.eoClip) {
      clipping = true;
    } else if (
      operation === OPS.fill ||
      operation === OPS.eoFill ||
      operation === OPS.fillStroke ||
      operation === OPS.eoFillStroke
    ) {
      if (!clipping && pendingPoints) {
        const region = regionFromPoints(pendingPoints, viewport, pageIndex);
        if (region) regions.push(region);
      }
      pendingPoints = undefined;
      clipping = false;
    } else if (
      operation === OPS.stroke ||
      operation === OPS.closeStroke ||
      operation === OPS.endPath
    ) {
      pendingPoints = undefined;
      clipping = false;
    }
  });

  return regions;
}

export async function detectShapeMarkers(
  page: PDFPageProxy,
  pageIndex: number,
): Promise<ImageRegion[]> {
  const operatorList = await page.getOperatorList();
  const viewport = page.getViewport({ scale: 1 });
  return shapeMarkerRegionsFromOperatorList(operatorList, viewport, pageIndex);
}

/** Fetch once, then run image and filled-shape detection over the shared operator list. */
export async function detectPageGraphicRegions(
  page: PDFPageProxy,
  pageIndex: number,
): Promise<PageGraphicRegions> {
  const operatorList = await page.getOperatorList();
  const viewport = page.getViewport({ scale: 1 });
  return {
    imageRegions: imageRegionsFromOperatorList(operatorList, viewport, pageIndex),
    shapeMarkerRegions: shapeMarkerRegionsFromOperatorList(operatorList, viewport, pageIndex),
  };
}
