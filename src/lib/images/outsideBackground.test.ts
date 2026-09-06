import { describe, expect, it } from 'vitest';
import type { PageViewport } from 'pdfjs-dist';
import type { PdfRect } from '@/lib/export/types';
import { outsideBandRects, sampleDeleteImageCover } from './outsideBackground';

type Rgba = readonly [number, number, number, number];

const CANVAS_SIZE = 120;
const TARGET: PdfRect = { x: 40, y: 40, w: 40, h: 40 };
const GREY: Rgba = [224, 224, 224, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const PHOTO: Rgba = [40, 90, 180, 255];
const viewport = {
  width: CANVAS_SIZE,
  height: CANVAS_SIZE,
  convertToViewportPoint: (x: number, y: number) => [x, CANVAS_SIZE - y],
  convertToPdfPoint: (x: number, y: number) => [x, CANVAS_SIZE - y],
} as unknown as PageViewport;

function canvasFrom(pixelAt: (x: number, y: number) => Rgba): HTMLCanvasElement {
  return {
    width: CANVAS_SIZE,
    height: CANVAS_SIZE,
    getContext: () => ({
      getImageData: (left: number, top: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4);
        let offset = 0;
        for (let y = top; y < top + height; y += 1) {
          for (let x = left; x < left + width; x += 1) {
            data.set(pixelAt(x, y), offset);
            offset += 4;
          }
        }
        return { data };
      },
    }),
  } as unknown as HTMLCanvasElement;
}

function inside(
  x: number,
  y: number,
  rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
): boolean {
  return (
    x >= rect.left && x < rect.left + rect.width &&
    y >= rect.top && y < rect.top + rect.height
  );
}

function flatCanvas(background: Rgba, margin?: { readonly inset: number; readonly color: Rgba }) {
  const photo = { left: 40, top: 40, width: 40, height: 40 };
  const card = margin ? {
    left: photo.left - margin.inset,
    top: photo.top - margin.inset,
    width: photo.width + margin.inset * 2,
    height: photo.height + margin.inset * 2,
  } : undefined;
  return canvasFrom((x, y) => {
    if (inside(x, y, photo)) return PHOTO;
    if (card && inside(x, y, card)) return margin?.color ?? WHITE;
    return background;
  });
}

const deleteOptions = {
  probeWidthPx: 2,
  pageRingInnerPx: 24,
  pageRingOuterPx: 40,
  maxExpansionPx: 40,
} as const;

describe('outsideBandRects', () => {
  it('returns four bands outside an interior image', () => {
    expect(outsideBandRects(
      { left: 20, top: 30, width: 40, height: 50 },
      100,
      120,
      5,
    )).toEqual([
      { left: 15, top: 25, width: 50, height: 5 },
      { left: 15, top: 80, width: 50, height: 5 },
      { left: 15, top: 30, width: 5, height: 50 },
      { left: 60, top: 30, width: 5, height: 50 },
    ]);
  });

  it('clips bands at page edges without sampling inside the image', () => {
    expect(outsideBandRects(
      { left: 0, top: 0, width: 90, height: 90 },
      100,
      100,
      5,
    )).toEqual([
      { left: 0, top: 90, width: 95, height: 5 },
      { left: 90, top: 0, width: 5, height: 90 },
    ]);
  });
});

describe('sampleDeleteImageCover', () => {
  it('expands over a white card margin and uses the real grey page color', () => {
    const sample = sampleDeleteImageCover(
      flatCanvas(GREY, { inset: 8, color: WHITE }),
      viewport,
      TARGET,
      deleteOptions,
    );

    expect(sample.rect).toEqual({ x: 32, y: 32, w: 56, h: 56 });
    expect(sample.color).toEqual({ r: 224 / 255, g: 224 / 255, b: 224 / 255 });
  });

  it('keeps the rect unchanged when a photo sits directly on the grey page', () => {
    const sample = sampleDeleteImageCover(flatCanvas(GREY), viewport, TARGET, deleteOptions);

    expect(sample.rect).toEqual(TARGET);
    expect(sample.color).toEqual({ r: 224 / 255, g: 224 / 255, b: 224 / 255 });
  });

  it.each([
    ['orange', [236, 128, 52, 255] as const],
    ['green', [52, 164, 92, 255] as const],
    ['yellow', [244, 210, 72, 255] as const],
  ])('samples a flat %s page without defaulting to white', (_name, color) => {
    const sample = sampleDeleteImageCover(flatCanvas(color), viewport, TARGET, deleteOptions);

    expect(sample.rect).toEqual(TARGET);
    expect(sample.color).toEqual({ r: color[0] / 255, g: color[1] / 255, b: color[2] / 255 });
  });

  it('does not expand into a non-uniform surrounding area', () => {
    const immediate = { left: 38, top: 38, width: 44, height: 44 };
    const photo = { left: 40, top: 40, width: 40, height: 40 };
    const canvas = canvasFrom((x, y) => {
      if (inside(x, y, photo)) return PHOTO;
      if (inside(x, y, immediate)) {
        return (x + y) % 2 === 0 ? [30, 30, 30, 255] : [250, 250, 250, 255];
      }
      return GREY;
    });

    expect(() => sampleDeleteImageCover(canvas, viewport, TARGET, deleteOptions)).not.toThrow();
    expect(sampleDeleteImageCover(canvas, viewport, TARGET, deleteOptions).rect).toEqual(TARGET);
  });

  it('never expands farther than the configured cap', () => {
    const sample = sampleDeleteImageCover(
      flatCanvas(GREY, { inset: 20, color: WHITE }),
      viewport,
      TARGET,
      { ...deleteOptions, maxExpansionPx: 6 },
    );

    expect(sample.rect).toEqual({ x: 34, y: 34, w: 52, h: 52 });
    expect(sample.color).toEqual({ r: 224 / 255, g: 224 / 255, b: 224 / 255 });
  });
});
