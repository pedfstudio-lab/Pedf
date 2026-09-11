import type { PDFPage } from 'pdf-lib';
import { nextRotation } from '@/lib/tools/rotateOptions';

export interface ReaderFrame {
  x0: number;
  y0: number;
  W: number;
  H: number;
  rotation: 0 | 90 | 180 | 270;
  width: number;
  height: number;
}

/** The visible CropBox expressed in the orientation a PDF reader shows to the user. */
export function readerFrame(page: PDFPage): ReaderFrame {
  const crop = page.getCropBox();
  const rotation = nextRotation(page.getRotation().angle, 0) as ReaderFrame['rotation'];
  const turned = rotation === 90 || rotation === 270;
  return {
    x0: crop.x,
    y0: crop.y,
    W: crop.width,
    H: crop.height,
    rotation,
    width: turned ? crop.height : crop.width,
    height: turned ? crop.width : crop.height,
  };
}

/** Map a point in displayed reader coordinates back into the page's raw PDF coordinates. */
export function readerToRaw(frame: ReaderFrame, u: number, v: number): { x: number; y: number } {
  switch (frame.rotation) {
    case 90: return { x: frame.x0 + frame.W - v, y: frame.y0 + u };
    case 180: return { x: frame.x0 + frame.W - u, y: frame.y0 + frame.H - v };
    case 270: return { x: frame.x0 + v, y: frame.y0 + frame.H - u };
    default: return { x: frame.x0 + u, y: frame.y0 + v };
  }
}

/** Convert a clockwise reader-space angle to the angle expected by the raw page. */
export function readerAngleToRaw(frame: ReaderFrame, degrees: number): number {
  return degrees + frame.rotation;
}
