import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, PDFName, PDFStream } from 'pdf-lib';
import { replacedImageFor } from '@/lib/edit/replacedImage';
import { worstBlockDiff } from '@/harness/pixelDiff';
import { imageDrawsInContent } from '@/lib/images/extractImage';
import { detectImageCandidates, imageDrawsFromOperatorList } from '@/lib/pdf/images';
import type { DrawnImage, ImageRegion } from '@/lib/pdf/images';
import type { CoverEdit, EditDocument, PdfRect } from './types';
import { exportPdf } from './exportPdf';

const imagesPath = 'tmp/image-removal/images (3).pdf';
const ziroPath = 'tmp/image-removal/Ziro Festival Firgun-edited-edited (1).pdf';
const optionalCanvas = await import('@napi-rs/canvas').catch(() => undefined);
const enabled = process.env.TASK68_REAL === '1' && existsSync(imagesPath) && existsSync(ziroPath);
if (!enabled) {
  process.stdout.write(
    'Task 68 real-file check skipped: set TASK68_REAL=1 with both tmp/image-removal fixtures present.\n',
  );
}

function sameRect(left: PdfRect, right: PdfRect, tolerance = 0.05): boolean {
  const leftEdges = [left.x, left.y, left.x + left.w, left.y + left.h];
  const rightEdges = [right.x, right.y, right.x + right.w, right.y + right.h];
  return leftEdges.every((edge, index) => Math.abs(edge - (rightEdges[index] ?? edge)) <= tolerance);
}

function storedImages(document: PDFDocument): PDFStream[] {
  const image = PDFName.of('Image');
  const subtype = PDFName.of('Subtype');
  return document.context.enumerateIndirectObjects().flatMap(([, object]) => (
    object instanceof PDFStream && object.dict.get(subtype) === image ? [object] : []
  ));
}

function drawnImages(document: PDFDocument): number {
  return document.getPages().reduce((total, _page, pageIndex) => (
    total + (imageDrawsInContent(document, pageIndex)?.length ?? 0)
  ), 0);
}

async function pageGeometry(reader: PDFDocumentProxy): Promise<EditDocument['pages']> {
  return Promise.all(Array.from({ length: reader.numPages }, async (_, pageIndex) => {
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
}

function coverFor(
  pageIndex: number,
  region: ImageRegion,
  draws: readonly DrawnImage[],
  id: string,
): CoverEdit {
  return {
    id,
    kind: 'cover',
    pageIndex,
    rect: {
      x: region.rect.x - 1,
      y: region.rect.y - 1,
      w: region.rect.w + 2,
      h: region.rect.h + 2,
    },
    z: 1,
    color: { r: 1, g: 1, b: 1 },
    sampleBackground: false,
    replacesImages: [replacedImageFor(region, draws)],
  };
}

async function renderFirstPage(bytes: Uint8Array): Promise<ImageData> {
  const createCanvas = optionalCanvas?.createCanvas;
  if (!createCanvas) throw new Error('Optional @napi-rs/canvas is unavailable.');
  const reader = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  try {
    const page = await reader.getPage(1);
    const viewport = page.getViewport({ scale: 150 / 72 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return {
      data: new Uint8ClampedArray(image.data),
      width: image.width,
      height: image.height,
      colorSpace: 'srgb',
    } as ImageData;
  } finally {
    await reader.destroy();
  }
}

(enabled ? describe : describe.skip)('Task 68 real image-removal files', () => {
  it('removes both page-one photos from images (3).pdf after the page was already read', async () => {
    const originalBytes = new Uint8Array(await readFile(imagesPath));
    const reader = await getDocument({ data: originalBytes.slice(), verbosity: 0 }).promise;
    let document: EditDocument;
    try {
      const page = await reader.getPage(1);
      await page.getOperatorList({ annotationMode: 2 });
      const candidates = await detectImageCandidates(page, 0);
      expect(candidates).toHaveLength(2);
      const draws = candidates.flatMap((candidate) => candidate.draw ? [candidate.draw] : []);
      document = {
        originalBytes,
        pages: await pageGeometry(reader),
        edits: candidates.map((candidate, index) => (
          coverFor(0, candidate.region, draws, `real-images-cover-${index}`)
        )),
      };
    } finally {
      await reader.destroy();
    }

    const [baseline, exported] = await Promise.all([
      exportPdf(document, { removeCoveredImages: false }),
      exportPdf(document),
    ]);
    if (process.env.TASK68_WRITE === '1') {
      await mkdir('tmp/pdfs', { recursive: true });
      await writeFile('tmp/pdfs/task68-rev1-images3-export.pdf', exported.bytes);
    }
    expect(exported.redaction).toMatchObject({ removedImages: 2, unmatchedImages: 0 });
    expect(exported.warnings).toEqual([]);
    const reopened = await PDFDocument.load(exported.bytes, { updateMetadata: false });
    const outputDraws = drawnImages(reopened);
    const outputStored = storedImages(reopened).length;
    const outputKiB = Math.round(exported.bytes.byteLength / 1024);
    process.stdout.write(
      `TASK68 REAL images (3).pdf | drawn ${outputDraws} | stored ${outputStored} | ${outputKiB} KiB\n`,
    );
    expect(outputDraws).toBe(4);
    expect(outputStored).toBe(4);
    expect(outputKiB).toBeGreaterThan(5_700);
    expect(outputKiB).toBeLessThan(5_900);
    if (optionalCanvas) {
      const [before, after] = await Promise.all([
        renderFirstPage(baseline.bytes),
        renderFirstPage(exported.bytes),
      ]);
      expect(worstBlockDiff(before, after).meanError).toBeLessThan(0.01);
    }
  }, 30_000);

  it('removes one document-unique Ziro photo from both the draws and stored objects', async () => {
    const originalBytes = new Uint8Array(await readFile(ziroPath));
    const source = await PDFDocument.load(originalBytes, { updateMetadata: false });
    const rawDraws = source.getPages().map((_page, pageIndex) => imageDrawsInContent(source, pageIndex) ?? []);
    const refUses = new Map<string, number>();
    for (const draw of rawDraws.flat()) {
      if (draw.ref) refUses.set(draw.ref.tag, (refUses.get(draw.ref.tag) ?? 0) + 1);
    }

    const reader = await getDocument({ data: originalBytes.slice(), verbosity: 0 }).promise;
    let selected: {
      readonly pageIndex: number;
      readonly region: ImageRegion;
      readonly draws: readonly DrawnImage[];
    } | undefined;
    let pages: EditDocument['pages'];
    try {
      pages = await pageGeometry(reader);
      for (let pageIndex = 0; pageIndex < reader.numPages && !selected; pageIndex += 1) {
        const page = await reader.getPage(pageIndex + 1);
        await page.getOperatorList({ annotationMode: 2 });
        const candidates = await detectImageCandidates(page, pageIndex);
        const draws = candidates.flatMap((candidate) => candidate.draw ? [candidate.draw] : []);
        const allDraws = imageDrawsFromOperatorList(
          await page.getOperatorList({ annotationMode: 0 }),
          page.getViewport({ scale: 1, rotation: 0 }),
          pageIndex,
        );
        for (const candidate of candidates) {
          const matching = rawDraws[pageIndex]?.filter((draw) => sameRect(draw.rect, candidate.region.rect)) ?? [];
          const raw = matching.length === 1 ? matching[0] : undefined;
          const matchingPdfJsDraws = allDraws.filter((draw) => (
            draw.kind === (candidate.draw?.kind ?? 'image')
            && sameRect(draw.region.rect, candidate.region.rect, 1)
          ));
          if (
            raw?.ref
            && matchingPdfJsDraws.length === 1
            && refUses.get(raw.ref.tag) === 1
            && raw.stream.dict.get(PDFName.of('SMask')) === undefined
            && raw.stream.dict.get(PDFName.of('Mask')) === undefined
          ) {
            selected = { pageIndex, region: candidate.region, draws };
            break;
          }
        }
      }
    } finally {
      await reader.destroy();
    }
    expect(selected, 'Ziro should contain a document-unique directly drawn photo').toBeDefined();
    if (!selected) return;

    const beforeDraws = drawnImages(source);
    const beforeStored = storedImages(source).length;
    const exported = await exportPdf({
      originalBytes,
      pages,
      edits: [coverFor(selected.pageIndex, selected.region, selected.draws, 'real-ziro-cover')],
    });
    expect(exported.redaction).toMatchObject({ removedImages: 1, unmatchedImages: 0 });
    expect(exported.warnings).toEqual([]);
    const reopened = await PDFDocument.load(exported.bytes, { updateMetadata: false });
    const afterDraws = drawnImages(reopened);
    const afterStored = storedImages(reopened).length;
    process.stdout.write(
      `TASK68 REAL Ziro | drawn ${beforeDraws}->${afterDraws} | stored ${beforeStored}->${afterStored}\n`,
    );
    expect(afterDraws).toBe(beforeDraws - 1);
    expect(afterStored).toBe(beforeStored - 1);
  }, 60_000);
});
