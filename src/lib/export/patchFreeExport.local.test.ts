import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import { buildTextBlockEdits, buildTextEdits } from '@/lib/edit/buildTextEdits';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import type { TextBlock } from '@/lib/pdf/textContent';
import type { CoverEdit, Edit, EditDocument, PdfRect } from './types';
import { planCoveredGlyphRemoval } from './coveredGlyphs';
import { exportPdf } from './exportPdf';
import { buildPageStreamTree } from './formStreams';

const baselinePath = 'tmp/tables/baseline.json';
const fixtures = {
  accommodation: 'tmp/tables/Firgun_QT-H4SNASRX_SriLanka.pdf',
  priceHeader: 'tmp/paragraphs/FIRGUN SRI 1.pdf',
  photoHeading: "tmp/paragraphs/Bhutan December'26.pdf",
} as const;
const optionalCanvas = await import('@napi-rs/canvas').catch(() => undefined);
const enabled = process.env.TASK74_PATCH === '1'
  && existsSync(baselinePath)
  && Object.values(fixtures).every(existsSync)
  && Boolean(optionalCanvas);
if (!enabled) {
  process.stdout.write(
    'Task 74 patch-free export check skipped: set TASK74_PATCH=1 with the baseline, three fixtures, and canvas present.\n',
  );
}

interface Baseline {
  version: number;
  files: Record<string, unknown>;
}

interface RenderedPage {
  readonly image: ImageData;
  readonly page: PDFPageProxy;
  readonly reader: PDFDocumentProxy;
  readonly scale: number;
}

interface PixelCase {
  readonly label: string;
  readonly file: string;
  readonly pageNumber: number;
  readonly find: string;
  readonly replacement: string;
  readonly surface: 'border' | 'photo';
}

const pixelCases: readonly PixelCase[] = [
  {
    label: 'Sri Lanka accommodation cell',
    file: fixtures.accommodation,
    pageNumber: 1,
    find: 'Daun LebarVillasUbud',
    replacement: 'PATCH FREE HOTEL',
    surface: 'border',
  },
  {
    label: 'FIRGUN SRI 1 price header',
    file: fixtures.priceHeader,
    pageNumber: 4,
    find: 'PRICE PER ADULT',
    replacement: 'PATCH FREE PRICE',
    surface: 'border',
  },
  {
    label: 'Bhutan photo heading',
    file: fixtures.photoHeading,
    pageNumber: 1,
    find: 'N E W',
    replacement: 'PATCH FREE TRIP',
    surface: 'photo',
  },
];

function normalized(value: string): string {
  return value.replace(/\s+/g, '').toLocaleLowerCase();
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

async function pageText(bytes: Uint8Array, pageNumber: number): Promise<string> {
  const reader = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  try {
    const content = await (await reader.getPage(pageNumber)).getTextContent();
    return content.items.flatMap((item) => 'str' in item ? [item.str] : []).join(' ');
  } finally {
    await reader.destroy();
  }
}

async function renderPage(bytes: Uint8Array, pageNumber: number, scale = 3): Promise<RenderedPage> {
  const createCanvas = optionalCanvas?.createCanvas;
  if (!createCanvas) throw new Error('Optional @napi-rs/canvas is unavailable.');
  const reader = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await reader.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    image: {
      data: new Uint8ClampedArray(pixels.data),
      width: pixels.width,
      height: pixels.height,
      colorSpace: 'srgb',
    } as ImageData,
    page,
    reader,
    scale,
  };
}

function toPixelRect(rendered: RenderedPage, rect: PdfRect, padding = 0): PdfRect {
  const viewport = rendered.page.getViewport({ scale: rendered.scale });
  const points = viewport.convertToViewportRectangle([
    rect.x,
    rect.y,
    rect.x + rect.w,
    rect.y + rect.h,
  ]);
  const left = Math.min(points[0] ?? 0, points[2] ?? 0) - padding;
  const top = Math.min(points[1] ?? 0, points[3] ?? 0) - padding;
  const right = Math.max(points[0] ?? 0, points[2] ?? 0) + padding;
  const bottom = Math.max(points[1] ?? 0, points[3] ?? 0) + padding;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function differentPixelCount(
  before: ImageData,
  after: ImageData,
  include: (x: number, y: number) => boolean,
): number {
  expect(after.width).toBe(before.width);
  expect(after.height).toBe(before.height);
  let changed = 0;
  for (let y = 0; y < before.height; y += 1) {
    for (let x = 0; x < before.width; x += 1) {
      if (!include(x, y)) continue;
      const offset = (y * before.width + x) * 4;
      if (
        before.data[offset] !== after.data[offset]
        || before.data[offset + 1] !== after.data[offset + 1]
        || before.data[offset + 2] !== after.data[offset + 2]
        || before.data[offset + 3] !== after.data[offset + 3]
      ) changed += 1;
    }
  }
  return changed;
}

function contains(rect: PdfRect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function rectKey(pageIndex: number, rect: PdfRect): string {
  return [pageIndex, rect.x, rect.y, rect.w, rect.h].map((value) => value.toFixed(4)).join(':');
}

async function firstRunOnEachTextPage(
  reader: PDFDocumentProxy,
): Promise<{ edits: Edit[]; covers: Map<number, CoverEdit> }> {
  const edits: Edit[] = [];
  const covers = new Map<number, CoverEdit>();
  for (let pageIndex = 0; pageIndex < reader.numPages; pageIndex += 1) {
    const page = await reader.getPage(pageIndex + 1);
    const runs = await extractTextRuns(page, pageIndex);
    const run = runs.find((candidate) => candidate.text.trim().length > 0);
    if (!run) continue;
    const built = buildTextEdits(run, {
      text: 'PATCH FREE',
      style: { ...run.style, fontRef: undefined },
      width: Math.max(run.rect.w, 50),
      height: run.rect.h,
      dx: 0,
      dy: 0,
    }, edits.length + 1);
    edits.push(built.cover, built.text);
    covers.set(pageIndex, built.cover);
  }
  return { edits, covers };
}

describe.skipIf(!enabled)('Task 74 patch-free export', () => {
  it.each(pixelCases)('preserves $label pixels and removes its old words', async (spec) => {
    const originalBytes = new Uint8Array(await readFile(spec.file));
    const reader = await getDocument({ data: originalBytes.slice(), verbosity: 0 }).promise;
    let target: TextBlock;
    let pages: EditDocument['pages'];
    let edits: Edit[];
    try {
      const pageIndex = spec.pageNumber - 1;
      const page = await reader.getPage(spec.pageNumber);
      const [runs, detectedRules, geometry] = await Promise.all([
        extractTextRuns(page, pageIndex),
        detectRuleLines(page, pageIndex),
        pageGeometry(reader),
      ]);
      pages = geometry;
      const blocks = groupRunsIntoBlocks(runs, { ruleLines: detectedRules });
      const found = blocks.find((block) => normalized(block.text).includes(normalized(spec.find)));
      expect(found, `${spec.label}: block containing ${JSON.stringify(spec.find)}`).toBeDefined();
      if (!found) return;
      target = found;
      const built = buildTextBlockEdits(target, {
        text: spec.replacement,
        style: { ...target.style, fontRef: undefined },
        width: target.rect.w,
        height: target.rect.h,
        dx: 0,
        dy: 0,
        align: target.align,
        alignLeftPt: target.alignLeftPt,
        alignWidthPt: target.alignWidthPt,
      }, [spec.replacement], 1);
      edits = [...built.covers, ...built.texts];
    } finally {
      await reader.destroy();
    }

    const sampled: PdfRect[] = [];
    const result = await exportPdf({
      originalBytes,
      pages,
      edits,
      sampleBackground: (_pageIndex, rect) => {
        sampled.push(rect);
        return { r: 1, g: 1, b: 1 };
      },
    });
    if (process.env.TASK74_PATCH_WRITE === '1') {
      await mkdir('tmp/task74-patch', { recursive: true });
      await writeFile(
        `tmp/task74-patch/${spec.label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`,
        result.bytes,
      );
    }
    expect(result.warnings, spec.label).toEqual([]);
    expect(result.redaction.skippedPages, spec.label).toBe(0);
    expect(result.redaction.removedItems, spec.label).toBeGreaterThan(0);
    expect(sampled, `${spec.label}: no redundant patch is sampled`).toEqual([]);

    const text = await pageText(result.bytes, spec.pageNumber);
    expect(normalized(text), `${spec.label}: old block text is gone`)
      .not.toContain(normalized(target.text));
    expect(text, `${spec.label}: replacement text is present`).toContain(spec.replacement);

    const [before, after] = await Promise.all([
      renderPage(originalBytes, spec.pageNumber),
      renderPage(result.bytes, spec.pageNumber),
    ]);
    try {
      // Two PDF points cover glyph antialiasing without reaching the enclosing cell rules.
      const textMask = toPixelRect(before, target.rect, 6);
      const changedOutsideText = differentPixelCount(before.image, after.image, (x, y) => (
        !contains(textMask, x, y)
      ));
      if (spec.surface === 'photo') {
        expect(changedOutsideText, `${spec.label}: photo pixels outside text ink`).toBe(0);
      } else {
        expect(
          changedOutsideText,
          `${spec.label}: surrounding pixels, including the cell borders`,
        ).toBe(0);
      }
    } finally {
      await Promise.all([before.reader.destroy(), after.reader.destroy()]);
    }
  }, 120_000);

  it('accounts for every emitted, skipped, and drawn cover across the 45-file baseline', async () => {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Baseline;
    const files = Object.keys(baseline.files).sort();
    expect(files).toHaveLength(45);
    const unreasoned: string[] = [];
    let totalEmitted = 0;
    let totalSkipped = 0;
    let totalDrawn = 0;
    let totalRefused = 0;

    for (const file of files) {
      const originalBytes = new Uint8Array(await readFile(file));
      const reader = await getDocument({ data: originalBytes.slice(), verbosity: 0 }).promise;
      try {
        const { edits, covers } = await firstRunOnEachTextPage(reader);
        const drawnKeys: string[] = [];
        const result = await exportPdf({
          originalBytes,
          pages: await pageGeometry(reader),
          edits,
          sampleBackground: (pageIndex, rect) => {
            drawnKeys.push(rectKey(pageIndex, rect));
            return { r: 1, g: 1, b: 1 };
          },
        });
        const coverByKey = new Map([...covers].map(([pageIndex, cover]) => [
          rectKey(pageIndex, cover.rect),
          { pageIndex, cover },
        ]));
        const refusedPages = new Set(result.warnings.flatMap((warning) => {
          const match = warning.match(/Old text on page (\d+) could not be removed/);
          return match?.[1] ? [Number(match[1]) - 1] : [];
        }));
        const source = await PDFDocument.load(originalBytes, { updateMetadata: false });
        for (const key of drawnKeys) {
          const drawn = coverByKey.get(key);
          if (!drawn) {
            unreasoned.push(`${file}: sampled unknown cover ${key}`);
            continue;
          }
          if (refusedPages.has(drawn.pageIndex)) continue;
          const page = await reader.getPage(drawn.pageIndex + 1);
          const tree = buildPageStreamTree(source, drawn.pageIndex);
          if (!tree) {
            unreasoned.push(`${file} p.${drawn.pageIndex + 1}: drawn without a decoded stream or refusal`);
            continue;
          }
          const plan = planCoveredGlyphRemoval(
            (await page.getTextContent()).items,
            await page.getOperatorList({ annotationMode: 0 }),
            page.getViewport({ scale: 1, rotation: 0 }),
            tree.roots,
            [{ rect: drawn.cover.rect, replaces: drawn.cover.replaces }],
          );
          if (!plan.skipped && plan.satisfied[0]) {
            unreasoned.push(`${file} p.${drawn.pageIndex + 1}: satisfied cover was drawn`);
          }
        }

        const emitted = covers.size;
        const drawn = drawnKeys.length;
        const skipped = emitted - drawn;
        totalEmitted += emitted;
        totalDrawn += drawn;
        totalSkipped += skipped;
        totalRefused += result.redaction.skippedPages;
        process.stdout.write(
          `TASK74 PATCH ${file} | covers emitted ${emitted} | skipped ${skipped}`
          + ` | drawn ${drawn} | pages refused ${result.redaction.skippedPages}\n`,
        );
      } finally {
        await reader.destroy();
      }
    }

    process.stdout.write(
      `TASK74 PATCH TOTAL files ${files.length} | covers emitted ${totalEmitted}`
      + ` | skipped ${totalSkipped} | drawn ${totalDrawn} | pages refused ${totalRefused}\n`,
    );
    for (const failure of unreasoned) process.stdout.write(`TASK74 PATCH UNREASONED ${failure}\n`);
    expect(unreasoned).toEqual([]);
    expect(totalEmitted).toBe(totalSkipped + totalDrawn);
  }, 600_000);
});
