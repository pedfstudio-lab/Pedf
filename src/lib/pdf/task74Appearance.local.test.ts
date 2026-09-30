import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { classifyFontStyle, extractTextRuns, groupRunsIntoBlocks } from './textContent';
import { resolveTextPaint, textPaintForItems } from './textPaint';
import { sampleCanvasTextBackground } from '@/lib/export/inkExtent';

const baselinePath = 'tmp/tables/baseline.json';
const duteesPath = 'C:/Users/eddyu/Downloads/DUTEES PRICE LIST APR26.pdf';
const outputPath = 'tmp/pdfs/task74-appearance-baseline.json';
const bhutanPath = "tmp/paragraphs/Bhutan December'26.pdf";
const firgunPath = 'tmp/paragraphs/FIRGUN SRI 1.pdf';
const optionalCanvas = await import('@napi-rs/canvas').catch(() => undefined);
const standardFontDirectory = fileURLToPath(
  new URL('../../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url),
);
const standardFontDataUrl = standardFontDirectory.endsWith(sep)
  ? standardFontDirectory
  : `${standardFontDirectory}${sep}`;
const enabled = process.env.TASK74_APPEARANCE === '1' && existsSync(baselinePath);
if (!enabled) {
  process.stdout.write(
    'Task 74 appearance measurement skipped: set TASK74_APPEARANCE=1 with the corpus baseline present.\n',
  );
}

interface Baseline {
  readonly files: Readonly<Record<string, unknown>>;
}

interface FileMeasurement {
  readonly file: string;
  readonly pages: number;
  readonly textItems: number;
  readonly mode3Items: number;
  readonly mode3ReturnedBefore: number;
  readonly unsupportedPaintItems: number;
  readonly unsupportedRenderingModes: Readonly<Record<string, number>>;
  readonly mappingFailures: number;
  readonly changedBoldBlocks: Readonly<Record<string, number>>;
  readonly groupingDifferences: number;
  readonly groupingDifferenceDetails: readonly string[];
}

interface FontProgramMetadata {
  readonly weight?: number;
  readonly macBold: boolean;
}

function fontProgramMetadata(data: Uint8Array | undefined): FontProgramMetadata {
  if (!data || data.length < 12) return { macBold: false };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numTables = view.getUint16(4);
  if (numTables === 0 || numTables > 64) return { macBold: false };
  let os2Offset: number | undefined;
  let headOffset: number | undefined;
  for (let index = 0; index < numTables; index += 1) {
    const recordOffset = 12 + index * 16;
    if (recordOffset + 16 > data.length) return { macBold: false };
    const tag = String.fromCharCode(
      data[recordOffset] ?? 0,
      data[recordOffset + 1] ?? 0,
      data[recordOffset + 2] ?? 0,
      data[recordOffset + 3] ?? 0,
    );
    const tableOffset = view.getUint32(recordOffset + 8);
    if (tag === 'OS/2') os2Offset = tableOffset;
    if (tag === 'head') headOffset = tableOffset;
  }
  const weight = os2Offset !== undefined && os2Offset + 6 <= data.length
    ? view.getUint16(os2Offset + 4)
    : undefined;
  const macBold = headOffset !== undefined && headOffset + 46 <= data.length
    ? (view.getUint16(headOffset + 44) & 0x1) !== 0
    : false;
  return { weight, macBold };
}

function increment(target: Record<string, number>, key: string, amount = 1): void {
  target[key] = (target[key] ?? 0) + amount;
}

function normalized(text: string): string {
  return text.replace(/\s+/g, '').toLocaleLowerCase();
}

function itemText(item: unknown): string | undefined {
  if (!item || typeof item !== 'object' || !('str' in item)) return undefined;
  const text = (item as { str?: unknown }).str;
  return typeof text === 'string' && text.trim() !== '' ? text : undefined;
}

function itemFontSize(item: unknown): number {
  if (!item || typeof item !== 'object' || !('transform' in item)) return 0;
  const transform = (item as { transform?: unknown }).transform;
  if (!Array.isArray(transform) && !ArrayBuffer.isView(transform)) return 0;
  const values = Array.from(transform as ArrayLike<unknown>);
  const c = typeof values[2] === 'number' ? values[2] : 0;
  const d = typeof values[3] === 'number' ? values[3] : 0;
  return Math.hypot(c, d);
}

function returnedCount(texts: readonly string[], returned: readonly string[]): number {
  const remaining = new Map<string, number>();
  for (const text of returned) remaining.set(text, (remaining.get(text) ?? 0) + 1);
  let count = 0;
  for (const text of texts) {
    const available = remaining.get(text) ?? 0;
    if (available <= 0) continue;
    count += 1;
    remaining.set(text, available - 1);
  }
  return count;
}

describe.runIf(enabled)('Task 74 Step 5a appearance baseline', () => {
  it('reads the real Bhutan, FIRGUN, and DUTEES appearance', async () => {
    expect(existsSync(bhutanPath)).toBe(true);
    expect(existsSync(firgunPath)).toBe(true);
    expect(existsSync(duteesPath)).toBe(true);

    const bhutanBytes = new Uint8Array(await readFile(bhutanPath));
    const bhutan = await getDocument({
      data: bhutanBytes,
      fontExtraProperties: true,
      standardFontDataUrl,
      verbosity: 0,
    }).promise;
    try {
      const page = await bhutan.getPage(1);
      const blocks = groupRunsIntoBlocks(await extractTextRuns(page, 0));
      const heading = blocks.find((block) => normalized(block.text).includes('bhutan'));
      expect(heading, 'Bhutan heading is editable').toBeDefined();
      expect(heading?.style.color.r).toBeGreaterThan(0.95);
      expect(heading?.style.color.g).toBeGreaterThan(0.95);
      expect(heading?.style.color.b).toBeGreaterThan(0.95);

      const createCanvas = optionalCanvas?.createCanvas;
      expect(createCanvas, 'real background sampling needs @napi-rs/canvas').toBeDefined();
      if (heading && createCanvas) {
        const viewport = page.getViewport({ scale: 3, rotation: 0 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        await page.render({
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;
        const background = sampleCanvasTextBackground({
          width: canvas.width,
          height: canvas.height,
          read: (x, y, width, height) => new Uint8ClampedArray(
            context.getImageData(x, y, width, height).data,
          ),
        }, viewport, heading.rect, heading.style.color);
        expect(
          Math.hypot(1 - background.r, 1 - background.g, 1 - background.b),
          'Bhutan samples the photograph rather than its white glyphs',
        ).toBeGreaterThan(0.12);
      }
    } finally {
      await bhutan.destroy();
    }

    const firgun = await getDocument({
      data: new Uint8Array(await readFile(firgunPath)),
      fontExtraProperties: true,
      verbosity: 0,
    }).promise;
    try {
      const blocks = groupRunsIntoBlocks(await extractTextRuns(await firgun.getPage(4), 3));
      const header = blocks.find((block) => normalized(block.text).includes('priceperadult'));
      expect(header, 'FIRGUN price header is editable').toBeDefined();
      expect(header?.style.color.b).toBeGreaterThan(header?.style.color.r ?? 1);
      expect(header?.style.color.b).toBeGreaterThan(header?.style.color.g ?? 1);
    } finally {
      await firgun.destroy();
    }

    const dutees = await getDocument({
      data: new Uint8Array(await readFile(duteesPath)),
      fontExtraProperties: true,
      verbosity: 0,
    }).promise;
    try {
      const page = await dutees.getPage(3);
      const blocks = groupRunsIntoBlocks(await extractTextRuns(page, 2));
      const semibold = blocks.find((block) => normalized(block.text).includes('50to149pcs'));
      const heavy = blocks.find((block) => normalized(block.text).includes('supima'));
      expect(semibold, 'DUTEES semibold cell is editable').toBeDefined();
      expect(semibold?.style.bold).toBe(false);
      expect(semibold?.style.sourceBold).toBe(false);
      expect(heavy, 'DUTEES heavy heading is editable').toBeDefined();
      expect(heavy?.style.bold).toBe(true);
      expect(heavy?.style.sourceBold).toBe(true);
    } finally {
      await dutees.destroy();
    }
  }, 120_000);

  it('measures invisible and unsupported text before product behaviour changes', async () => {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Baseline;
    const corpus = Object.keys(baseline.files).filter((file) => existsSync(file));
    if (existsSync(duteesPath) && !corpus.includes(duteesPath)) corpus.push(duteesPath);
    const files: FileMeasurement[] = [];

    for (const file of corpus) {
      const bytes = new Uint8Array(await readFile(file));
      const document = await getDocument({ data: bytes, fontExtraProperties: true, verbosity: 0 }).promise;
      let textItems = 0;
      let mode3Items = 0;
      let mode3ReturnedBefore = 0;
      let unsupportedPaintItems = 0;
      const unsupportedRenderingModes: Record<string, number> = {};
      let mappingFailures = 0;
      const changedBoldBlocks: Record<string, number> = {};
      let groupingDifferences = 0;
      const groupingDifferenceDetails: string[] = [];
      try {
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
          const page = await document.getPage(pageNumber);
          const [content, operatorList] = await Promise.all([
            page.getTextContent(),
            page.getOperatorList(),
          ]);
          const paint = textPaintForItems(content.items, operatorList);
          if (!paint) {
            mappingFailures += 1;
            continue;
          }
          const candidates = content.items.flatMap((item, index) => {
            const text = itemText(item);
            const state = paint[index];
            return text ? [{
              text,
              paint: state ? resolveTextPaint(state, itemFontSize(item)) : undefined,
            }] : [];
          });
          textItems += candidates.length;
          const hidden = candidates.filter(({ paint: state }) => state?.renderingMode === 3);
          mode3Items += hidden.length;
          for (const { paint: state } of candidates) {
            if (state && state.visible && !state.supported) {
              unsupportedPaintItems += 1;
              increment(unsupportedRenderingModes, String(state.renderingMode));
            }
          }
          const runs = await extractTextRuns(page, pageNumber - 1);
          if (hidden.length > 0) {
            mode3ReturnedBefore += returnedCount(
              hidden.map(({ text }) => text),
              runs.map((run) => run.text),
            );
          }
          const fontDiagnostics = new Map<string, { readonly name: string; readonly oldBold: boolean }>();
          for (const run of runs) {
            const fontRef = run.style.fontRef;
            if (!fontRef || fontDiagnostics.has(fontRef)) continue;
            const fontObject = page.commonObjs.has(fontRef)
              ? page.commonObjs.get(fontRef) as { name?: unknown; data?: unknown }
              : undefined;
            const name = typeof fontObject?.name === 'string' && fontObject.name.trim() !== ''
              ? fontObject.name
              : content.styles[fontRef]?.fontFamily ?? fontRef;
            const data = fontObject?.data as Uint8Array | undefined;
            const program = fontProgramMetadata(data);
            const oldBold = classifyFontStyle(name).bold
              || (program.weight ?? 0) >= 600
              || program.macBold;
            fontDiagnostics.set(fontRef, { name, oldBold });
          }
          const oldRuns = runs.map((run) => {
            const diagnostic = run.style.fontRef ? fontDiagnostics.get(run.style.fontRef) : undefined;
            const oldBold = diagnostic?.oldBold ?? run.style.bold;
            return { ...run, style: { ...run.style, bold: oldBold, sourceBold: oldBold } };
          });
          const blockKey = (block: ReturnType<typeof groupRunsIntoBlocks>[number]) => [
            block.text,
            block.rect.x.toFixed(4),
            block.rect.y.toFixed(4),
            block.rect.w.toFixed(4),
            block.rect.h.toFixed(4),
          ].join('|');
          const currentBlocks = new Map(groupRunsIntoBlocks(runs).map((block) => [blockKey(block), block]));
          for (const oldBlock of groupRunsIntoBlocks(oldRuns)) {
            const currentBlock = currentBlocks.get(blockKey(oldBlock));
            if (!currentBlock) {
              groupingDifferences += 1;
              groupingDifferenceDetails.push(
                `p.${pageNumber} old block ${JSON.stringify(oldBlock.text.slice(0, 160))}`,
              );
              continue;
            }
            if (oldBlock.style.bold === currentBlock.style.bold) continue;
            const currentRun = currentBlock.lines[0]?.runs[0];
            const diagnostic = currentRun?.style.fontRef
              ? fontDiagnostics.get(currentRun.style.fontRef)
              : undefined;
            increment(changedBoldBlocks, diagnostic?.name ?? currentRun?.style.fontName ?? 'unknown');
          }
        }
      } finally {
        await document.destroy();
      }
      files.push({
        file,
        pages: document.numPages,
        textItems,
        mode3Items,
        mode3ReturnedBefore,
        unsupportedPaintItems,
        unsupportedRenderingModes,
        mappingFailures,
        changedBoldBlocks,
        groupingDifferences,
        groupingDifferenceDetails,
      });
    }

    const totals = files.reduce(
      (sum, file) => ({
        files: sum.files + 1,
        textItems: sum.textItems + file.textItems,
        mode3Items: sum.mode3Items + file.mode3Items,
        mode3ReturnedBefore: sum.mode3ReturnedBefore + file.mode3ReturnedBefore,
        unsupportedPaintItems: sum.unsupportedPaintItems + file.unsupportedPaintItems,
        unsupportedRenderingModes: Object.entries(file.unsupportedRenderingModes).reduce(
          (modes, [mode, count]) => {
            increment(modes, mode, count);
            return modes;
          }, sum.unsupportedRenderingModes,
        ),
        mappingFailures: sum.mappingFailures + file.mappingFailures,
        changedBoldBlocks: Object.entries(file.changedBoldBlocks).reduce(
          (fonts, [font, count]) => {
            increment(fonts, font, count);
            return fonts;
          }, sum.changedBoldBlocks,
        ),
        groupingDifferences: sum.groupingDifferences + file.groupingDifferences,
        groupingDifferenceDetails: [
          ...sum.groupingDifferenceDetails,
          ...file.groupingDifferenceDetails.map((detail) => `${file.file}: ${detail}`),
        ],
      }),
      {
        files: 0,
        textItems: 0,
        mode3Items: 0,
        mode3ReturnedBefore: 0,
        unsupportedPaintItems: 0,
        unsupportedRenderingModes: {} as Record<string, number>,
        mappingFailures: 0,
        changedBoldBlocks: {} as Record<string, number>,
        groupingDifferences: 0,
        groupingDifferenceDetails: [] as string[],
      },
    );
    await mkdir('tmp/pdfs', { recursive: true });
    await writeFile(outputPath, `${JSON.stringify({ totals, files }, null, 2)}\n`);
    process.stdout.write(`Task 74 appearance baseline ${JSON.stringify(totals)} -> ${outputPath}\n`);
    expect(files.length).toBeGreaterThan(0);
  }, 300_000);
});
