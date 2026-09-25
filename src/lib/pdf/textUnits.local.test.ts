import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildTextBlockEdits } from '@/lib/edit/buildTextEdits';
import type { PageExportContext } from '@/lib/export/context';
import { resolvePageFontResource } from '@/lib/export/embeddedFont';
import { standardFontFor } from '@/lib/export/englishFont';
import { exportPdf } from '@/lib/export/exportPdf';
import type { Edit, PdfRect, TextAlignment } from '@/lib/export/types';
import type { PageGeometry } from './types';
import { detectRuleLines } from './ruleLines';
import { renderPage } from './renderPage';
import {
  classifyFontFamily,
  detectTextAlignment,
  extractTextRuns,
  groupRunsIntoBlocks,
  isTableNumber,
} from './textContent';
import type { TextBlock, TextLine, TextRun } from './textContent';

const baselinePath = 'tmp/tables/baseline.json';
const enabled = process.env.TASK74_UNITS === '1' && existsSync(baselinePath);
if (!enabled) {
  process.stdout.write(
    'Task 74 measurement skipped: set TASK74_UNITS=1 with tmp/tables/baseline.json present.\n',
  );
}

interface BaselinePage { readonly pageIndex: number }
interface BaselineFile { readonly pages: readonly BaselinePage[] }
interface Baseline { readonly files: Readonly<Record<string, BaselineFile>> }

const openDocuments: PDFDocumentProxy[] = [];

afterEach(async () => {
  await Promise.all(openDocuments.splice(0).map((document) => document.destroy()));
});

function unionRects(rects: readonly PdfRect[]): PdfRect {
  const first = rects[0];
  if (!first) return { x: 0, y: 0, w: 0, h: 0 };
  const left = Math.min(...rects.map((rect) => rect.x));
  const bottom = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const top = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? (ordered[middle] ?? 0)
    : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}

function lineText(runs: readonly TextRun[]): string {
  const [first, ...rest] = runs;
  if (!first) return '';
  let text = first.text.trim();
  let previous = first;
  for (const run of rest) {
    const part = run.text.trim();
    if (!part) continue;
    const gap = run.rect.x - (previous.rect.x + previous.rect.w);
    const spaceThreshold = Math.max(
      0.75,
      Math.min(previous.style.fontSizePt, run.style.fontSizePt) * 0.08,
    );
    const punctuation = /^[,.;:!?%)}\]]/.test(part) || '([{/'.includes(text.at(-1) ?? '');
    if (gap > spaceThreshold && !punctuation) text += ' ';
    text += part;
    previous = run;
  }
  return text;
}

function makeLine(runs: readonly TextRun[]): TextLine {
  const style = runs.reduce((best, run) => (
    run.text.trim().length > best.text.trim().length ? run : best
  )).style;
  return {
    pageIndex: runs[0]?.pageIndex ?? 0,
    text: lineText(runs),
    rect: unionRects(runs.map((run) => run.rect)),
    baselineY: runs.reduce((sum, run) => sum + run.rect.y, 0) / Math.max(1, runs.length),
    style,
    runs,
  };
}

/** Step 0 prototype of Task 74's row-local split rule; production remains untouched. */
function splitRowsIntoPieces(runs: readonly TextRun[]): TextLine[] {
  const rows: Array<{ pageIndex: number; baselineY: number; runs: TextRun[] }> = [];
  const sorted = [...runs].sort((left, right) => (
    left.pageIndex - right.pageIndex || right.rect.y - left.rect.y || left.rect.x - right.rect.x
  ));
  for (const run of sorted) {
    const tolerance = Math.max(1.5, run.style.fontSizePt * 0.18);
    const row = rows
      .filter((candidate) => candidate.pageIndex === run.pageIndex)
      .sort((left, right) => (
        Math.abs(left.baselineY - run.rect.y) - Math.abs(right.baselineY - run.rect.y)
      ))
      .find((candidate) => Math.abs(candidate.baselineY - run.rect.y) <= tolerance);
    if (row) {
      row.runs.push(run);
      row.baselineY = row.runs.reduce((sum, item) => sum + item.rect.y, 0) / row.runs.length;
    } else {
      rows.push({ pageIndex: run.pageIndex, baselineY: run.rect.y, runs: [run] });
    }
  }

  const pieces: TextLine[] = [];
  for (const row of rows) {
    const ordered = [...row.runs].sort((left, right) => left.rect.x - right.rect.x);
    const wideGaps = ordered.slice(1).flatMap((run, index) => {
      const previous = ordered[index];
      if (!previous) return [];
      const gap = run.rect.x - (previous.rect.x + previous.rect.w);
      const size = Math.max(previous.style.fontSizePt, run.style.fontSizePt);
      return gap > Math.max(18, size * 1.75) ? [{ gap, size }] : [];
    });
    const largest = Math.max(0, ...wideGaps.map(({ gap }) => gap));
    const stretched = wideGaps.length >= 2 && wideGaps.every(({ gap, size }) => (
      gap >= largest * 0.8 && gap <= size * 3
    ));

    let segment: TextRun[] = [];
    for (const run of ordered) {
      const previous = segment.at(-1);
      const gap = previous ? run.rect.x - (previous.rect.x + previous.rect.w) : 0;
      const size = Math.max(previous?.style.fontSizePt ?? 0, run.style.fontSizePt);
      const splitWide = Boolean(previous && gap > Math.max(18, size * 1.75) && !stretched);
      const splitNumbers = Boolean(previous
        && isTableNumber(previous.text)
        && isTableNumber(run.text)
        && gap > Math.max(3, size * 0.4));
      if (splitWide || splitNumbers) {
        pieces.push(makeLine(segment));
        segment = [];
      }
      segment.push(run);
    }
    if (segment.length > 0) pieces.push(makeLine(segment));
  }
  return pieces.sort((left, right) => (
    left.pageIndex - right.pageIndex
    || right.baselineY - left.baselineY
    || left.rect.x - right.rect.x
  ));
}

function canJoinParagraph(lines: readonly TextLine[], line: TextLine): boolean {
  const previous = lines.at(-1);
  if (!previous || previous.pageIndex !== line.pageIndex) return false;
  // Numeric cells must remain independently editable down a table column.
  if (isTableNumber(previous.text) || isTableNumber(line.text)) return false;
  const size = Math.max(previous.style.fontSizePt, line.style.fontSizePt);
  const verticalGap = previous.baselineY - line.baselineY;
  if (verticalGap <= 0.5 || verticalGap > size * 1.85) return false;
  if (Math.abs(previous.style.fontSizePt - line.style.fontSizePt) > Math.max(1.5, size * 0.22)) {
    return false;
  }
  if (
    classifyFontFamily(previous.style.fontName) !== classifyFontFamily(line.style.fontName)
    || previous.style.bold !== line.style.bold
    || previous.style.italic !== line.style.italic
  ) return false;

  const startDelta = Math.abs(previous.rect.x - line.rect.x);
  const overlap = Math.max(0,
    Math.min(previous.rect.x + previous.rect.w, line.rect.x + line.rect.w)
    - Math.max(previous.rect.x, line.rect.x));
  const overlapRatio = overlap / Math.max(1, Math.min(previous.rect.w, line.rect.w));
  if (startDelta > Math.max(9, size) && overlapRatio < 0.7) return false;

  if (lines.length >= 2) {
    const gaps = lines.slice(1).map((item, index) => (
      (lines[index]?.baselineY ?? item.baselineY) - item.baselineY
    ));
    const expected = median(gaps);
    if (Math.abs(verticalGap - expected) > Math.max(2, expected * 0.35)) return false;
  }

  const widestRight = Math.max(...[...lines, line].map((item) => item.rect.x + item.rect.w));
  return widestRight - (previous.rect.x + previous.rect.w) <= size * 2;
}

function blockAlignment(lines: readonly TextLine[]): TextAlignment {
  if (lines.length < 2) return lines[0]?.align ?? 'left';
  const size = Math.max(...lines.map((line) => line.style.fontSizePt));
  const tolerance = Math.max(2, size * 0.15);
  const aligned = (values: readonly number[]) => Math.max(...values) - Math.min(...values) <= tolerance;
  if (aligned(lines.map((line) => line.rect.x))) return 'left';
  if (aligned(lines.map((line) => line.rect.x + line.rect.w))) return 'right';
  if (aligned(lines.map((line) => line.rect.x + line.rect.w / 2))) return 'center';
  return 'left';
}

/** Step 0 prototype of Task 74's immediate-neighbour paragraph rule. */
function task74Blocks(runs: readonly TextRun[]): TextBlock[] {
  const pageBounds = new Map<number, { left: number; right: number }>();
  for (const run of runs) {
    const bounds = pageBounds.get(run.pageIndex);
    const right = run.rect.x + run.rect.w;
    if (bounds) {
      bounds.left = Math.min(bounds.left, run.rect.x);
      bounds.right = Math.max(bounds.right, right);
    } else pageBounds.set(run.pageIndex, { left: run.rect.x, right });
  }
  const lines = splitRowsIntoPieces(runs).map((line) => {
    const bounds = pageBounds.get(line.pageIndex) ?? {
      left: line.rect.x,
      right: line.rect.x + line.rect.w,
    };
    return {
      ...line,
      align: detectTextAlignment(line.rect, bounds.left, bounds.right, line.style.fontSizePt),
      alignLeftPt: bounds.left,
      alignWidthPt: bounds.right - bounds.left,
    };
  });

  const groups: TextLine[][] = [];
  for (const line of lines) {
    const target = groups
      .filter((group) => canJoinParagraph(group, line))
      .sort((left, right) => (
        Math.abs((left.at(-1)?.rect.x ?? 0) - line.rect.x)
        - Math.abs((right.at(-1)?.rect.x ?? 0) - line.rect.x)
      ))[0];
    if (target) target.push(line);
    else groups.push([line]);
  }

  return groups.map((group) => {
    const rect = unionRects(group.map((line) => line.rect));
    const style = group[0]!.style;
    const gaps = group.slice(1).map((line, index) => (
      (group[index]?.baselineY ?? line.baselineY) - line.baselineY
    ));
    const align = blockAlignment(group);
    const single = group.length === 1;
    return {
      pageIndex: group[0]!.pageIndex,
      text: group.map((line) => line.text).join('\n'),
      rect,
      topBaselineY: Math.max(...group.map((line) => line.baselineY)),
      lineHeightPt: median(gaps) || style.fontSizePt * 1.2,
      style,
      lines: group,
      align,
      ...(single ? {
        alignLeftPt: group[0]?.alignLeftPt,
        alignWidthPt: group[0]?.alignWidthPt,
      } : align === 'left' ? {} : {
        alignLeftPt: rect.x,
        alignWidthPt: rect.w,
      }),
    };
  });
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of right) counts.set(value, (counts.get(value) ?? 0) + 1);
  return left.filter((value) => {
    const count = counts.get(value) ?? 0;
    if (count === 0) return true;
    counts.set(value, count - 1);
    return false;
  });
}

function preview(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, ' ').slice(0, 100));
}

function fontContext(pdf: PDFDocument, pageIndex: number): PageExportContext {
  const page = pdf.getPage(pageIndex);
  return {
    pdf,
    page,
    geometry: {
      pageIndex,
      widthPt: page.getWidth(),
      heightPt: page.getHeight(),
      rotation: 0,
      boxOffset: { x: 0, y: 0 },
    },
    warnings: [],
    drawRect: () => undefined,
    sampleBackground: () => undefined,
  };
}

async function geometry(document: PDFDocumentProxy): Promise<PageGeometry[]> {
  return Promise.all(Array.from({ length: document.numPages }, async (_, pageIndex) => {
    const page = await document.getPage(pageIndex + 1);
    const [left = 0, bottom = 0, right = 0, top = 0] = page.view;
    return {
      pageIndex,
      widthPt: right - left,
      heightPt: top - bottom,
      rotation: ((page.rotate % 360) + 360) % 360 as PageGeometry['rotation'],
      boxOffset: { x: left, y: bottom },
    };
  }));
}

function stats(values: readonly number[]): string {
  const ordered = [...values].sort((left, right) => left - right);
  return `${ordered[0]?.toFixed(0)}/${median(ordered).toFixed(0)}/${ordered.at(-1)?.toFixed(0)}`;
}

async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - started };
}

async function singlePageBytes(bytes: Uint8Array, pageIndex: number): Promise<Uint8Array> {
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  const output = await PDFDocument.create({ updateMetadata: false });
  const [page] = await output.copyPages(source, [pageIndex]);
  if (!page) throw new Error(`Could not copy page ${pageIndex + 1}`);
  output.addPage(page);
  return output.save();
}

function remapEdits(edits: readonly Edit[]): Edit[] {
  return edits.map((edit) => ({ ...edit, pageIndex: 0 }));
}

async function renderAtZoomOne(bytes: Uint8Array, pageNumber: number): Promise<void> {
  const reader = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const previousWindow = (globalThis as { window?: unknown }).window;
  try {
    const page = await reader.getPage(pageNumber);
    const canvas = createCanvas(1, 1) as unknown as HTMLCanvasElement;
    Object.assign(canvas, { style: { width: '', height: '' } });
    (globalThis as { window?: unknown }).window = {
      devicePixelRatio: 1,
      requestAnimationFrame: (callback: FrameRequestCallback) => (
        setTimeout(() => callback(performance.now()), 0) as unknown as number
      ),
      cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    };
    await renderPage(page, canvas, 1).task.promise;
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
    await reader.destroy();
  }
}

describe.skipIf(!enabled)('Task 74 Step 0 measurements', () => {
  it('reports prospective click units and document-font coverage without assertions', async () => {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Baseline;
    let todayTotal = 0;
    let nextTotal = 0;
    let changedTotal = 0;
    let ownFontTotal = 0;
    let substitutedTotal = 0;

    process.stdout.write('TASK74 PART A — click units\n');
    for (const [file, expected] of Object.entries(baseline.files)
      .sort(([left], [right]) => left.localeCompare(right))) {
      const bytes = new Uint8Array(await readFile(file));
      const browser = await getDocument({ data: bytes.slice(), verbosity: 0, fontExtraProperties: true }).promise;
      openDocuments.push(browser);
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      const today: string[] = [];
      const next: string[] = [];
      let ownFont = 0;
      const substitutions = new Map<string, number>();

      for (const expectedPage of expected.pages) {
        const page = await browser.getPage(expectedPage.pageIndex + 1);
        const [runs, ruleLines] = await Promise.all([
          extractTextRuns(page, expectedPage.pageIndex),
          detectRuleLines(page, expectedPage.pageIndex),
        ]);
        const todayBlocks = groupRunsIntoBlocks(runs, { ruleLines });
        const nextBlocks = task74Blocks(runs);
        today.push(...todayBlocks.map((block) => block.text));
        next.push(...nextBlocks.map((block) => block.text));

        const context = fontContext(pdf, expectedPage.pageIndex);
        for (const block of nextBlocks) {
          if (resolvePageFontResource(context, block.style)) ownFont += 1;
          else {
            const name = standardFontFor(
              classifyFontFamily(block.style.fontName),
              block.style.bold,
              block.style.italic,
            );
            substitutions.set(name, (substitutions.get(name) ?? 0) + 1);
          }
        }
      }

      const removed = difference(today, next);
      const added = difference(next, today);
      todayTotal += today.length;
      nextTotal += next.length;
      changedTotal += removed.length + added.length;
      ownFontTotal += ownFont;
      substitutedTotal += next.length - ownFont;
      process.stdout.write(
        `${file} | pieces ${today.length} -> ${next.length}`
        + ` | changed ${removed.length} OLD / ${added.length} NEW\n`,
      );
      for (const value of removed) process.stdout.write(`  OLD ${preview(value)}\n`);
      for (const value of added) process.stdout.write(`  NEW ${preview(value)}\n`);
      process.stdout.write(
        `  FONT own ${ownFont} | substituted ${next.length - ownFont}`
        + ` | ${JSON.stringify(Object.fromEntries([...substitutions].sort()))}\n`,
      );
      await browser.destroy();
      openDocuments.splice(openDocuments.indexOf(browser), 1);
    }
    const fontTotal = ownFontTotal + substitutedTotal;
    process.stdout.write(
      `TASK74 PART A TOTAL files ${Object.keys(baseline.files).length}`
      + ` | pieces ${todayTotal} -> ${nextTotal} | changed ${changedTotal}\n`,
    );
    process.stdout.write(
      `TASK74 PART B TOTAL own ${ownFontTotal} | substituted ${substitutedTotal}`
      + ` | own-font ${fontTotal ? (ownFontTotal / fontTotal * 100).toFixed(1) : '0.0'}%\n`,
    );
  }, 600_000);

  it('reports whole-document export, single-page export and redraw timings', async () => {
    const samples = [
      { file: 'tmp/paragraphs/Corporate-Governance-edited (25).pdf', pageNumber: 3, find: 'A number of Postgraduate' },
      { file: "tmp/paragraphs/Bhutan December'26.pdf", pageNumber: 6, find: 'After breakfast' },
      { file: 'tmp/tables/Fraction Chart.pdf', pageNumber: 1, find: '%' },
    ];
    process.stdout.write('TASK74 PART C — min/median/max ms (Node canvas is a browser proxy)\n');
    for (const sample of samples) {
      if (!existsSync(sample.file)) {
        process.stdout.write(`${sample.file} | missing; timing skipped\n`);
        continue;
      }
      const bytes = new Uint8Array(await readFile(sample.file));
      const browser = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
      openDocuments.push(browser);
      const pages = await geometry(browser);
      const pageIndex = sample.pageNumber - 1;
      const page = await browser.getPage(sample.pageNumber);
      const runs = await extractTextRuns(page, pageIndex);
      const block = task74Blocks(runs).find((candidate) => candidate.text.includes(sample.find));
      if (!block) {
        process.stdout.write(`${sample.file} p${sample.pageNumber} | text target missing; timing skipped\n`);
        continue;
      }
      const replacement = `${block.lines[0]?.text ?? block.text}*`;
      const built = buildTextBlockEdits(block, {
        text: replacement,
        style: block.style,
        width: block.rect.w,
        height: block.rect.h,
        dx: 0,
        dy: 0,
        align: block.align,
        alignLeftPt: block.alignLeftPt,
        alignWidthPt: block.alignWidthPt,
      }, [replacement], 0);
      const edits = [...built.covers, ...built.texts];
      const onePageBytes = await singlePageBytes(bytes, pageIndex);
      const onePageGeometry = [{ ...pages[pageIndex]!, pageIndex: 0 }];
      const onePageEdits = remapEdits(edits);
      const wholeMs: number[] = [];
      const singleMs: number[] = [];
      const renderMs: number[] = [];
      for (let iteration = 0; iteration < 3; iteration += 1) {
        const whole = await timed(() => exportPdf({ originalBytes: bytes, pages, edits }));
        wholeMs.push(whole.ms);
        const single = await timed(() => exportPdf({
          originalBytes: onePageBytes,
          pages: onePageGeometry,
          edits: onePageEdits,
        }));
        singleMs.push(single.ms);
        renderMs.push((await timed(() => renderAtZoomOne(whole.value.bytes, sample.pageNumber))).ms);
      }
      process.stdout.write(
        `${sample.file} | pages ${browser.numPages} | ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB`
        + ` | whole ${stats(wholeMs)} | single ${stats(singleMs)} | reopen+render ${stats(renderMs)}\n`,
      );
      await browser.destroy();
      openDocuments.splice(openDocuments.indexOf(browser), 1);
    }
  }, 600_000);
});
