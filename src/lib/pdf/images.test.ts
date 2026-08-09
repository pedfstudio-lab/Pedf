import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PageViewport } from 'pdfjs-dist';
import {
  detectImageCandidates,
  detectImages,
  filterTextBackedRegions,
  imageRegionsFromOperatorList,
  PARAGRAPH_TEXT,
  TEXT_RUN_INSIDE_RATIO,
} from './images';
import type { OperatorListLike } from './images';
import type { TextRun } from './textContent';

function viewport(height = 400): PageViewport {
  return {
    transform: [1, 0, 0, -1, 0, height],
    convertToPdfPoint: (x: number, y: number) => [x, height - y],
  } as unknown as PageViewport;
}

function textRun(rect: { x: number; y: number; w: number; h: number }, text = 'Review'): TextRun {
  return {
    pageIndex: 0,
    text,
    rect,
    style: {
      fontName: 'Helvetica',
      fontSizePt: 10,
      bold: false,
      italic: false,
      color: { r: 0, g: 0, b: 0 },
    },
  };
}

describe('filterTextBackedRegions', () => {
  const region = { pageIndex: 0, rect: { x: 0, y: 0, w: 100, h: 100 } };

  it('reports substantially contained text without treating a short title as a paragraph', () => {
    expect(filterTextBackedRegions(
      [region],
      [textRun({ x: 10, y: 10, w: 80, h: 10 }, 'Destination title')],
    )).toEqual([{ region, hasText: true, paragraph: false }]);
  });

  it('marks running text above the high character threshold as a paragraph', () => {
    expect(filterTextBackedRegions(
      [region],
      [textRun({ x: 5, y: 5, w: 90, h: 40 }, 'x'.repeat(PARAGRAPH_TEXT + 1))],
    )).toEqual([{ region, hasText: true, paragraph: true }]);
  });

  it('requires the configured proportion of a text run to sit inside the region', () => {
    const below = textRun({ x: -41, y: 10, w: 100, h: 10 });
    const boundary = textRun({ x: -(1 - TEXT_RUN_INSIDE_RATIO) * 100, y: 20, w: 100, h: 10 });
    expect(filterTextBackedRegions([region], [below])).toEqual([
      { region, hasText: false, paragraph: false },
    ]);
    expect(filterTextBackedRegions([region], [boundary])).toEqual([
      { region, hasText: true, paragraph: false },
    ]);
  });

  it('ignores blank text and runs from other pages', () => {
    expect(filterTextBackedRegions(
      [region],
      [
        textRun({ x: 0, y: 0, w: 100, h: 100 }, '   '),
        { ...textRun({ x: 0, y: 0, w: 100, h: 100 }), pageIndex: 1 },
      ],
    )).toEqual([{ region, hasText: false, paragraph: false }]);
  });
});

describe('imageRegionsFromOperatorList', () => {
  it('tracks save/restore and maps the image unit square back to PDF points', () => {
    const operators: OperatorListLike = {
      fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
      argsArray: [[], [100, 0, 0, 50, 20, 30], ['img'], []],
    };

    expect(imageRegionsFromOperatorList(operators, viewport(), 2)).toEqual([{
      pageIndex: 2,
      rect: { x: 20, y: 30, w: 100, h: 50 },
    }]);
  });

  it('applies nested form matrices and restores the outer CTM', () => {
    const operators: OperatorListLike = {
      fnArray: [
        OPS.paintFormXObjectBegin,
        OPS.transform,
        OPS.paintInlineImageXObject,
        OPS.paintFormXObjectEnd,
        OPS.transform,
        OPS.paintImageMaskXObject,
      ],
      argsArray: [
        [[1, 0, 0, 1, 10, 20]],
        [40, 0, 0, 30, 5, 6],
        [{}],
        [],
        [20, 0, 0, 10, 2, 3],
        [{}],
      ],
    };

    expect(imageRegionsFromOperatorList(operators, viewport(), 0)).toEqual([
      { pageIndex: 0, rect: { x: 15, y: 26, w: 40, h: 30 } },
      { pageIndex: 0, rect: { x: 2, y: 3, w: 20, h: 10 } },
    ]);
  });
});

describe('detectImages', () => {
  it('finds plausible existing-image targets on the bundled sample', async () => {
    const bytes = new Uint8Array(await readFile(
      new URL('../../../public/samples/sample-basic.pdf', import.meta.url),
    ));
    const document = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    try {
      const page = await document.getPage(1);
      const regions = await detectImages(page, 0);
      const size = page.getViewport({ scale: 1, rotation: 0 });
      expect(regions.length).toBeGreaterThan(0);
      for (const region of regions) {
        expect(region.pageIndex).toBe(0);
        expect(region.rect.w).toBeGreaterThan(0.1);
        expect(region.rect.h).toBeGreaterThan(0.1);
        expect(region.rect.x).toBeGreaterThanOrEqual(-1);
        expect(region.rect.y).toBeGreaterThanOrEqual(-1);
        expect(region.rect.x + region.rect.w).toBeLessThanOrEqual(size.width + 1);
        expect(region.rect.y + region.rect.h).toBeLessThanOrEqual(size.height + 1);
      }
    } finally {
      await document.destroy();
    }
  });

  it('returns the raw image targets throughout the GOA 2026 itinerary', async () => {
    const bytes = new Uint8Array(await readFile(
      new URL('../../../public/samples/GOA 2026.pdf', import.meta.url),
    ));
    const document = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    const expectedCounts = [4, 3, 6, 2, 2, 3, 2, 10, 9, 5, 4, 3, 4, 2, 3, 4];
    try {
      const counts: number[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        counts.push((await detectImages(page, pageNumber - 1)).length);
      }
      expect(counts).toEqual(expectedCounts);
    } finally {
      await document.destroy();
    }
  });

  it('pairs raw GOA targets with browser-side text signals', async () => {
    const bytes = new Uint8Array(await readFile(
      new URL('../../../public/samples/GOA 2026.pdf', import.meta.url),
    ));
    const document = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    try {
      const page = await document.getPage(2);
      const candidates = await detectImageCandidates(page, 1);
      expect(candidates).toHaveLength(3);
      expect(candidates.some((candidate) => candidate.hasText)).toBe(true);
    } finally {
      await document.destroy();
    }
  });
});
