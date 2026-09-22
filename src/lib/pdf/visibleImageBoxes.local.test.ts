import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { PdfRect } from '@/lib/export/types';
import {
  filterTextBackedRegions,
  imageDrawsFromOperatorList,
} from './images';
import type { DrawnImage, ImageRegion } from './images';
import { extractTextRuns } from './textContent';

const roots = [
  'tmp/bullets', 'tmp/compress-tests', 'tmp/pdfs/task52-merge-qa',
  'tmp/pdfs/task53-split-qa', 'tmp/repair-tests', 'tmp/sign-tests',
  'tmp/text-doubling', 'tmp/image-removal',
];
const enabled = process.env.TASK69_BOXES === '1' && roots.some(existsSync);
if (!enabled) {
  process.stdout.write(
    'Task 69 visible-image-box sweep skipped: set TASK69_BOXES=1 with tmp/ test PDFs present.\n',
  );
}

interface Counts {
  readonly photos: number;
  readonly unchanged: number;
  readonly pageEdge: number;
  readonly trimmed: number;
  readonly worst: number;
}

interface MutableCounts {
  photos: number;
  unchanged: number;
  pageEdge: number;
  trimmed: number;
  worst: number;
  before: number;
  after: number;
}

async function pdfFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await pdfFiles(path));
    else if (entry.isFile() && /\.pdf$/i.test(entry.name)) files.push(path);
  }
  return files;
}

function rectEdges(rect: PdfRect): readonly [number, number, number, number] {
  return [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h];
}

function sameRect(left: PdfRect, right: PdfRect, tolerance = 0.01): boolean {
  const leftEdges = rectEdges(left);
  const rightEdges = rectEdges(right);
  return leftEdges.every((edge, index) => (
    Math.abs(edge - (rightEdges[index] ?? edge)) <= tolerance
  ));
}

function uniqueRegions(draws: readonly DrawnImage[], visible: boolean): ImageRegion[] {
  const regions = draws.flatMap((draw) => {
    const rect = visible ? draw.visibleRect : draw.region.rect;
    return rect ? [{ pageIndex: draw.region.pageIndex, rect }] : [];
  });
  return regions.filter((region, index) => (
    regions.findIndex((candidate) => sameRect(candidate.rect, region.rect)) === index
  ));
}

function intersect(left: PdfRect, right: PdfRect): PdfRect | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const farX = Math.min(left.x + left.w, right.x + right.w);
  const farY = Math.min(left.y + left.h, right.y + right.h);
  if (farX - x <= 0.1 || farY - y <= 0.1) return undefined;
  return { x, y, w: farX - x, h: farY - y };
}

function trimDistances(placed: PdfRect, visible: PdfRect): readonly number[] {
  return [
    visible.x - placed.x,
    visible.y - placed.y,
    placed.x + placed.w - visible.x - visible.w,
    placed.y + placed.h - visible.y - visible.h,
  ];
}

function pageBounds(page: PDFPageProxy): PdfRect {
  const [left = 0, bottom = 0, right = 0, top = 0] = page.view;
  return {
    x: Math.min(left, right),
    y: Math.min(bottom, top),
    w: Math.abs(right - left),
    h: Math.abs(top - bottom),
  };
}

function classify(
  draw: DrawnImage,
  pageRect: PdfRect,
  counts: MutableCounts,
  file: string,
): void {
  counts.photos += 1;
  const visible = draw.visibleRect;
  const pageClipped = intersect(draw.region.rect, pageRect);
  if (!visible) {
    if (!pageClipped) counts.pageEdge += 1;
    else {
      counts.trimmed += 1;
      counts.worst = Math.max(counts.worst, pageClipped.w, pageClipped.h);
    }
    return;
  }

  const [placedLeft, placedBottom, placedRight, placedTop] = rectEdges(draw.region.rect);
  const [visibleLeft, visibleBottom, visibleRight, visibleTop] = rectEdges(visible);
  expect(visibleLeft, `${file}: visible left edge escaped its placed box`).toBeGreaterThanOrEqual(placedLeft - 0.01);
  expect(visibleBottom, `${file}: visible bottom edge escaped its placed box`).toBeGreaterThanOrEqual(placedBottom - 0.01);
  expect(visibleRight, `${file}: visible right edge escaped its placed box`).toBeLessThanOrEqual(placedRight + 0.01);
  expect(visibleTop, `${file}: visible top edge escaped its placed box`).toBeLessThanOrEqual(placedTop + 0.01);

  const worst = Math.max(...trimDistances(draw.region.rect, visible));
  if (worst < 1) {
    counts.unchanged += 1;
  } else if (pageClipped && sameRect(visible, pageClipped, 1)) {
    counts.pageEdge += 1;
  } else {
    counts.trimmed += 1;
    counts.worst = Math.max(
      counts.worst,
      Math.max(...trimDistances(pageClipped ?? draw.region.rect, visible)),
    );
  }
}

function expectedCounts(file: string): Counts | undefined {
  const normalized = file.replaceAll('\\', '/').toLowerCase();
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (
    normalized.includes('/bullets/')
    && name.includes('rahul')
    && name !== 'rahul_resume.pdf.pdf'
  ) {
    return { photos: 21, unchanged: 21, pageEdge: 0, trimmed: 0, worst: 0 };
  }
  if (normalized.includes('/text-doubling/') && ['rahul-rajput-edited.pdf', 'rahul-source.pdf'].includes(name)) {
    return { photos: 21, unchanged: 21, pageEdge: 0, trimmed: 0, worst: 0 };
  }
  if (
    (normalized.includes('/compress-tests/')
      && ['cv-signed.pdf', 'cv-signed-compressed.pdf', 'rishi-ilovepdf.pdf', 'rishi-signed.pdf'].includes(name))
    || normalized.endsWith('/text-doubling/rishi-edited.pdf')
  ) return { photos: 1, unchanged: 1, pageEdge: 0, trimmed: 0, worst: 0 };
  if (normalized.includes('/compress-tests/images__2_')) {
    return { photos: 14, unchanged: 14, pageEdge: 0, trimmed: 0, worst: 0 };
  }
  if (normalized.includes('/compress-tests/images__3_') || normalized.endsWith('/image-removal/images (3).pdf')) {
    return { photos: 6, unchanged: 6, pageEdge: 0, trimmed: 0, worst: 0 };
  }
  if (normalized.endsWith('/text-doubling/corporate-edited-3.pdf')) {
    return { photos: 33, unchanged: 33, pageEdge: 0, trimmed: 0, worst: 0 };
  }
  if (name === 'healing.pdf') {
    return { photos: 88, unchanged: 69, pageEdge: 9, trimmed: 10, worst: 179 };
  }
  if (normalized.endsWith('/text-doubling/ziro.pdf')
    || normalized.endsWith('/image-removal/ziro festival firgun-edited-edited (1).pdf')) {
    return { photos: 110, unchanged: 92, pageEdge: 7, trimmed: 11, worst: 179 };
  }
  if (name === 'ladakh.pdf' || name === 'ladakh-original.pdf') {
    return { photos: 124, unchanged: 87, pageEdge: 17, trimmed: 20, worst: 205 };
  }
  if (normalized.endsWith('/text-doubling/delhi-tour.pdf')) {
    return { photos: 62, unchanged: 47, pageEdge: 7, trimmed: 8, worst: 138 };
  }
  if (normalized.endsWith('/repair-tests/1-healthy-goa.pdf')) {
    return { photos: 66, unchanged: 45, pageEdge: 9, trimmed: 12, worst: 382 };
  }
  if (normalized.endsWith('/pdfs/task52-merge-qa/sample-goa-merged.pdf')) {
    return { photos: 80, unchanged: 59, pageEdge: 9, trimmed: 12, worst: 382 };
  }
  if (name === 'goa 2026-pages-1-8.pdf') {
    return { photos: 32, unchanged: 27, pageEdge: 0, trimmed: 5, worst: 382 };
  }
  if (name === 'goa 2026-pages-9-16.pdf') {
    return { photos: 34, unchanged: 18, pageEdge: 9, trimmed: 7, worst: 179 };
  }
  if (normalized.endsWith("/image-removal/vietnam sept'26.pdf")) {
    return { photos: 91, unchanged: 21, pageEdge: 32, trimmed: 38, worst: 490 };
  }
  return undefined;
}

function assertExpected(file: string, actual: MutableCounts): void {
  const expected = expectedCounts(file);
  if (!expected) return;
  expect(actual.photos, `${file}: photo count`).toBe(expected.photos);
  expect(actual.unchanged, `${file}: unchanged count`).toBe(expected.unchanged);
  expect(actual.pageEdge, `${file}: page-edge count`).toBe(expected.pageEdge);
  expect(actual.trimmed, `${file}: trimmed-frame count`).toBe(expected.trimmed);
  expect(actual.worst, `${file}: worst trim`).toBeCloseTo(expected.worst, 0);
}

(enabled ? describe : describe.skip)('Task 69 visible image boxes across the PDF corpus', () => {
  it('never enlarges a box and reproduces the independently measured classifications', async () => {
    const files = (await Promise.all(roots.map(pdfFiles))).flat().sort();
    let assertedFiles = 0;
    let readableFiles = 0;
    for (const file of files) {
      let reader: Awaited<ReturnType<typeof getDocument>>['promise'] extends Promise<infer T> ? T : never;
      try {
        const bytes = new Uint8Array(await readFile(file));
        reader = await getDocument({ data: bytes, verbosity: 0 }).promise;
      } catch (error) {
        process.stdout.write(`TASK69 BOXES ${file} | unreadable: ${error instanceof Error ? error.message : String(error)}\n`);
        continue;
      }
      const counts: MutableCounts = {
        photos: 0, unchanged: 0, pageEdge: 0, trimmed: 0, worst: 0, before: 0, after: 0,
      };
      try {
        readableFiles += 1;
        for (let pageIndex = 0; pageIndex < reader.numPages; pageIndex += 1) {
          const page = await reader.getPage(pageIndex + 1);
          const [operatorList, textRuns] = await Promise.all([
            page.getOperatorList({ annotationMode: 0 }),
            extractTextRuns(page, pageIndex),
          ]);
          const draws = imageDrawsFromOperatorList(
            operatorList,
            page.getViewport({ scale: 1, rotation: 0 }),
            pageIndex,
          );
          for (const draw of draws) classify(draw, pageBounds(page), counts, file);
          counts.before += filterTextBackedRegions(uniqueRegions(draws, false), textRuns).length;
          counts.after += filterTextBackedRegions(uniqueRegions(draws, true), textRuns).length;
        }
      } finally {
        await reader.destroy();
      }
      assertExpected(file, counts);
      if (expectedCounts(file)) assertedFiles += 1;
      process.stdout.write(
        `TASK69 BOXES ${file} | photos ${counts.photos} | unchanged ${counts.unchanged}`
        + ` | page-edge ${counts.pageEdge} | trimmed ${counts.trimmed}`
        + ` | worst ${counts.worst.toFixed(1)} pt | candidates ${counts.before}->${counts.after}\n`,
      );
    }
    expect(readableFiles).toBeGreaterThan(0);
    expect(assertedFiles).toBeGreaterThanOrEqual(29);
  }, 120_000);
});
