import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { imageDrawsFromOperatorList } from '@/lib/pdf/images';
import { exportPdf } from './exportPdf';
import type { EditDocument } from './types';

const fixtures = [
  'tmp/text-doubling/ziro.pdf',
  'tmp/repair-tests/1-healthy-GOA.pdf',
];
const enabled = process.env.TASK68_SPEED === '1' && fixtures.every(existsSync);
if (!enabled) process.stdout.write('Task 68 speed check skipped: set TASK68_SPEED=1 with both fixtures present.\n');

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? 0;
}

function sameRect(
  left: ReturnType<typeof imageDrawsFromOperatorList>[number],
  right: ReturnType<typeof imageDrawsFromOperatorList>[number],
): boolean {
  if (left.kind !== right.kind) return false;
  const leftRect = left.region.rect;
  const rightRect = right.region.rect;
  const leftEdges = [leftRect.x, leftRect.y, leftRect.x + leftRect.w, leftRect.y + leftRect.h];
  const rightEdges = [rightRect.x, rightRect.y, rightRect.x + rightRect.w, rightRect.y + rightRect.h];
  return leftEdges.every((edge, index) => Math.abs(edge - (rightEdges[index] ?? edge)) <= 1);
}

describe.skipIf(!enabled)('Task 68 local export speed', () => {
  for (const file of fixtures) {
    it(`reports cover-only and image-removal timing for ${file}`, async () => {
      const originalBytes = new Uint8Array(await readFile(file));
      const reader = await getDocument({ data: originalBytes.slice(), verbosity: 0 }).promise;
      try {
        const pages = await Promise.all(Array.from({ length: reader.numPages }, async (_, pageIndex) => {
          const page = await reader.getPage(pageIndex + 1);
          const [left = 0, bottom = 0, right = 0, top = 0] = page.view;
          return {
            pageIndex,
            widthPt: right - left,
            heightPt: top - bottom,
            rotation: ((page.rotate % 360) + 360) % 360 as 0 | 90 | 180 | 270,
            boxOffset: { x: left, y: bottom },
          };
        }));
        let target: ReturnType<typeof imageDrawsFromOperatorList>[number] | undefined;
        for (let pageIndex = 0; pageIndex < reader.numPages && !target; pageIndex += 1) {
          const page = await reader.getPage(pageIndex + 1);
          const draws = imageDrawsFromOperatorList(
            await page.getOperatorList({ annotationMode: 0 }),
            page.getViewport({ scale: 1, rotation: 0 }),
            pageIndex,
          );
          target = draws.find((candidate) => (
            draws.filter((draw) => sameRect(draw, candidate)).length === 1
          ));
        }
        expect(target, `${file} should contain at least one uniquely placed image draw`).toBeDefined();
        if (!target) return;
        const doc: EditDocument = {
          originalBytes,
          pages,
          edits: [{
            id: 'task68-speed-cover',
            kind: 'cover',
            pageIndex: target.region.pageIndex,
            rect: target.region.rect,
            z: 1,
            color: { r: 1, g: 1, b: 1 },
            sampleBackground: false,
            replacesImages: [{
              kind: target.kind,
              rect: target.region.rect,
            }],
          }],
        };
        const coverOnly: number[] = [];
        const removeImage: number[] = [];
        for (let run = 0; run < 3; run += 1) {
          let start = performance.now();
          await exportPdf(doc, { removeCoveredImages: false });
          coverOnly.push(performance.now() - start);
          start = performance.now();
          const output = await exportPdf(doc);
          removeImage.push(performance.now() - start);
          expect(output.redaction.imageSkippedPages).toBe(0);
          expect(output.redaction.removedImages).toBe(1);
        }
        process.stdout.write(
          `TASK68 SPEED ${file} | before ${median(coverOnly).toFixed(1)} ms`
          + ` | after ${median(removeImage).toFixed(1)} ms\n`,
        );
      } finally {
        await reader.destroy();
      }
    }, 120_000);
  }
});
