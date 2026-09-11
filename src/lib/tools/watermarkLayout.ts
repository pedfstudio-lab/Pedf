import type { WatermarkAngle, WatermarkPosition } from './watermarkOptions';

export interface WatermarkPlacement { u: number; v: number }

export interface WatermarkPlacementInput {
  pageWidth: number;
  pageHeight: number;
  itemWidth: number;
  itemHeight: number;
  angle: WatermarkAngle;
  position: WatermarkPosition;
  margin: number;
  /** For `position: 'custom'`: the item's centre as shares of the page — x from the left, y from the TOP. */
  custom?: { x: number; y: number };
}

/** Centre limits (reader points) that keep a turned item entirely on the page; centred if it cannot fit. */
export interface CentreRange { minX: number; maxX: number; minY: number; maxY: number }

interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

function rotatedBounds(width: number, height: number, radians: number): Bounds {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const points = [
    { x: 0, y: 0 },
    { x: width * cos, y: width * sin },
    { x: -height * sin, y: height * cos },
    { x: width * cos - height * sin, y: width * sin + height * cos },
  ];
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function centredStart(cx: number, cy: number, width: number, height: number, radians: number): WatermarkPlacement {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    u: cx - width * cos / 2 + height * sin / 2,
    v: cy - width * sin / 2 - height * cos / 2,
  };
}

export function centreRange(
  pageWidth: number,
  pageHeight: number,
  itemWidth: number,
  itemHeight: number,
  angle: number,
): CentreRange {
  const bounds = rotatedBounds(itemWidth, itemHeight, angle * Math.PI / 180);
  const halfWidth = (bounds.maxX - bounds.minX) / 2;
  const halfHeight = (bounds.maxY - bounds.minY) / 2;
  const fit = (half: number, size: number): [number, number] => half * 2 >= size ? [size / 2, size / 2] : [half, size - half];
  const [minX, maxX] = fit(halfWidth, pageWidth);
  const [minY, maxY] = fit(halfHeight, pageHeight);
  return { minX, maxX, minY, maxY };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function watermarkPlacements(input: WatermarkPlacementInput): WatermarkPlacement[] {
  const { pageWidth, pageHeight, itemWidth, itemHeight, angle, position, margin } = input;
  const radians = angle * Math.PI / 180;
  if (position === 'custom') {
    // A dragged spot: the same share of every page, clamped so the whole turned item stays on the page.
    const range = centreRange(pageWidth, pageHeight, itemWidth, itemHeight, angle);
    const cx = clamp((input.custom?.x ?? 0.5) * pageWidth, range.minX, range.maxX);
    const cy = clamp((1 - (input.custom?.y ?? 0.5)) * pageHeight, range.minY, range.maxY);
    return [centredStart(cx, cy, itemWidth, itemHeight, radians)];
  }
  if (position === 'tile') {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const diagonal = Math.hypot(pageWidth, pageHeight);
    const along = Math.max(itemWidth * 1.5, 1);
    const across = Math.max(itemHeight * 4, 1);
    const alongSteps = Math.ceil(diagonal / along) + 2;
    const acrossSteps = Math.ceil(diagonal / across) + 2;
    const outside = itemWidth / 2 + itemHeight;
    const placements: WatermarkPlacement[] = [];
    for (let row = -acrossSteps; row <= acrossSteps; row += 1) {
      for (let column = -alongSteps; column <= alongSteps; column += 1) {
        const offsetX = column * along * cos - row * across * sin;
        const offsetY = column * along * sin + row * across * cos;
        const cx = pageWidth / 2 + offsetX;
        const cy = pageHeight / 2 + offsetY;
        if (cx < -outside || cx > pageWidth + outside || cy < -outside || cy > pageHeight + outside) continue;
        placements.push(centredStart(cx, cy, itemWidth, itemHeight, radians));
      }
    }
    return placements;
  }

  const bounds = rotatedBounds(itemWidth, itemHeight, radians);
  const horizontal = position.endsWith('l') || position === 'l' ? 'left'
    : position.endsWith('r') || position === 'r' ? 'right' : 'center';
  const vertical = position.startsWith('t') || position === 't' ? 'top'
    : position.startsWith('b') || position === 'b' ? 'bottom' : 'center';
  const u = horizontal === 'left' ? margin - bounds.minX
    : horizontal === 'right' ? pageWidth - margin - bounds.maxX
      : (pageWidth - (bounds.maxX + bounds.minX)) / 2;
  const v = vertical === 'bottom' ? margin - bounds.minY
    : vertical === 'top' ? pageHeight - margin - bounds.maxY
      : (pageHeight - (bounds.maxY + bounds.minY)) / 2;
  return [{ u, v }];
}

export function autoFontSize(textWidthAt1pt: number, pageWidth: number, pageHeight: number, angle: WatermarkAngle): number {
  if (!(textWidthAt1pt > 0)) return 12;
  const target = angle === 90 ? pageHeight * 0.6
    : angle === 45 || angle === -45 ? Math.hypot(pageWidth, pageHeight) * 0.6
      : pageWidth * 0.6;
  return Math.min(200, Math.max(12, target / textWidthAt1pt));
}
