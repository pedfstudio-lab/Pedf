import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { PageGeometry } from '@/lib/pdf/types';
import { exportPdf } from './exportPdf';

const SAMPLE_PDF = new URL('../../../public/samples/sample-basic.pdf', import.meta.url);

function toPageGeometry(
  pageIndex: number,
  page: ReturnType<PDFDocument['getPage']>,
): PageGeometry {
  const mediaBox = page.getMediaBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;

  if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
    throw new Error(`unsupported page rotation: ${rotation}`);
  }

  return {
    pageIndex,
    widthPt: mediaBox.width,
    heightPt: mediaBox.height,
    rotation,
    boxOffset: { x: mediaBox.x, y: mediaBox.y },
  };
}

describe('Phase 0 acceptance', () => {
  it('round-trips the real sample without changing page structure', async () => {
    const originalBytes = new Uint8Array(await readFile(SAMPLE_PDF));
    const original = await PDFDocument.load(originalBytes, { updateMetadata: false });
    const pages = original
      .getPages()
      .map((page, pageIndex) => toPageGeometry(pageIndex, page));

    const result = await exportPdf({
      originalBytes,
      edits: [],
      pages,
    });

    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe('%PDF-');
    expect(result.warnings).toEqual([]);

    const reopened = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(reopened.getPageCount()).toBe(original.getPageCount());

    for (let pageIndex = 0; pageIndex < original.getPageCount(); pageIndex += 1) {
      const sourcePage = original.getPage(pageIndex);
      const exportedPage = reopened.getPage(pageIndex);

      expect(exportedPage.getSize()).toEqual(sourcePage.getSize());
      expect(exportedPage.getRotation().angle).toBe(sourcePage.getRotation().angle);
    }
  });
});
