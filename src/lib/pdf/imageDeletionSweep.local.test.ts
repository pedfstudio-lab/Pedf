import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { PDFDocument, PDFName, PDFStream } from 'pdf-lib';
import { replacedImageFor } from '@/lib/edit/replacedImage';
import { worstBlockDiff } from '@/harness/pixelDiff';
import { imageDrawsInContent } from '@/lib/images/extractImage';
import type { ContentImageDraw } from '@/lib/images/extractImage';
import { exportPdf } from '@/lib/export/exportPdf';
import type { CoverEdit, EditDocument, PdfRect } from '@/lib/export/types';
import {
  detectImageCandidates,
  imageDrawsFromOperatorList,
} from './images';
import type { DrawnImage, ImageRegionTextSignals } from './images';

const roots = [
  'tmp/bullets', 'tmp/compress-tests', 'tmp/pdfs/task52-merge-qa',
  'tmp/pdfs/task53-split-qa', 'tmp/repair-tests', 'tmp/sign-tests',
  'tmp/text-doubling',
];
const optionalCanvas = await import('@napi-rs/canvas').catch(() => undefined);
const enabled = process.env.TASK68_IMAGE_SWEEP === '1' && roots.some(existsSync);
if (!enabled) {
  process.stdout.write(
    'Task 68 local image-deletion sweep skipped: set TASK68_IMAGE_SWEEP=1 with tmp/ test PDFs present.\n',
  );
}

interface PageScan {
  readonly pageIndex: number;
  readonly candidates: readonly ImageRegionTextSignals[];
  readonly candidateDraws: readonly DrawnImage[];
  readonly allDraws: readonly DrawnImage[];
}

interface RunSpec {
  readonly label: string;
  readonly pageIndex: number;
  readonly edits: readonly CoverEdit[];
  readonly sharedRef?: string;
}

interface CachedPageState {
  readonly draws: readonly DrawnImage[];
  readonly text: readonly unknown[];
}

interface VerificationCache {
  readonly pages: Map<number, CachedPageState>;
  readonly sourceRenders: Map<number, ImageData>;
  readonly rawPages: readonly (readonly ContentImageDraw[])[];
  readonly reader: PDFDocumentProxy;
}

interface SweepResult {
  file: string;
  pages: number;
  candidates: number;
  removed: number;
  stackedExtras: number;
  sharedObjectRuns: number;
  skippedPages: number;
  outsideCover: number;
  unmatched: number;
  failures: number;
  ms: number;
  details: string[];
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

function sameRect(left: PdfRect, right: PdfRect, tolerance = 1): boolean {
  const leftEdges = [left.x, left.y, left.x + left.w, left.y + left.h];
  const rightEdges = [right.x, right.y, right.x + right.w, right.y + right.h];
  return leftEdges.every((edge, index) => Math.abs(edge - (rightEdges[index] ?? edge)) <= tolerance);
}

function matches(left: DrawnImage, right: DrawnImage): boolean {
  return left.kind === right.kind && sameRect(left.region.rect, right.region.rect);
}

function coverClaims(draw: DrawnImage, edits: readonly CoverEdit[]): boolean {
  return edits.some((edit) => edit.replacesImages?.some((replacement) => (
    draw.kind === replacement.kind && sameRect(draw.region.rect, replacement.rect)
  )) ?? false);
}

function rawCoverClaims(draw: ContentImageDraw, edits: readonly CoverEdit[]): boolean {
  return edits.some((edit) => edit.replacesImages?.some((replacement) => (
    replacement.kind === 'image' && sameRect(draw.rect, replacement.rect)
  )) ?? false);
}

function coverFor(
  pageIndex: number,
  candidate: ImageRegionTextSignals,
  draws: readonly DrawnImage[],
  id: string,
): CoverEdit {
  return {
    id,
    kind: 'cover',
    pageIndex,
    rect: { ...candidate.region.rect },
    z: 1,
    color: { r: 1, g: 1, b: 1 },
    sampleBackground: false,
    replacesImages: [replacedImageFor(candidate.region, draws)],
  };
}

function stackedGroups(draws: readonly DrawnImage[]): DrawnImage[][] {
  const groups: DrawnImage[][] = [];
  for (const draw of draws) {
    const group = groups.find((candidate) => (
      candidate[0]?.kind === draw.kind && sameRect(candidate[0].region.rect, draw.region.rect)
    ));
    if (group) group.push(draw);
    else groups.push([draw]);
  }
  return groups.filter((group) => group.length >= 2);
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

async function scanPage(page: PDFPageProxy, pageIndex: number): Promise<PageScan> {
  // Reproduce the editor order: the visible page is evaluated before image discovery.
  await page.getOperatorList({ annotationMode: 2 });
  const candidates = await detectImageCandidates(page, pageIndex);
  const candidateDraws = candidates.flatMap((candidate) => candidate.draw ? [candidate.draw] : []);
  const allDraws = imageDrawsFromOperatorList(
    await page.getOperatorList({ annotationMode: 0 }),
    page.getViewport({ scale: 1, rotation: 0 }),
    pageIndex,
  );
  return { pageIndex, candidates, candidateDraws, allDraws };
}

function imageRefTags(document: PDFDocument): Set<string> {
  const image = PDFName.of('Image');
  const subtype = PDFName.of('Subtype');
  return new Set(document.context.enumerateIndirectObjects().flatMap(([ref, object]) => (
    object instanceof PDFStream && object.dict.get(subtype) === image ? [ref.tag] : []
  )));
}

function rawDraws(document: PDFDocument): ContentImageDraw[][] | null {
  const pages: ContentImageDraw[][] = [];
  for (let pageIndex = 0; pageIndex < document.getPageCount(); pageIndex += 1) {
    const draws = imageDrawsInContent(document, pageIndex);
    if (!draws) return null;
    pages.push(draws);
  }
  return pages;
}

function textSnapshot(items: Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items']): unknown[] {
  return items.flatMap((item) => 'str' in item ? [[
    item.str,
    item.transform[4] ?? 0,
    item.transform[5] ?? 0,
  ]] : []);
}

async function renderPage(page: PDFPageProxy): Promise<ImageData> {
  const createCanvas = optionalCanvas?.createCanvas;
  if (!createCanvas) throw new Error('optional @napi-rs/canvas is unavailable');
  const viewport = page.getViewport({ scale: 150 / 72 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  await page.render({
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return {
    data: new Uint8ClampedArray(image.data),
    width: image.width,
    height: image.height,
    colorSpace: 'srgb',
  } as ImageData;
}

function maskCoveredPixels(
  before: ImageData,
  after: ImageData,
  page: PDFPageProxy,
  edits: readonly CoverEdit[],
): ImageData {
  if (edits.length === 0) return after;
  const data = new Uint8ClampedArray(after.data);
  const viewport = page.getViewport({ scale: 150 / 72 });
  for (const edit of edits) {
    const [firstX = 0, firstY = 0, secondX = 0, secondY = 0] = viewport.convertToViewportRectangle([
      edit.rect.x - 1,
      edit.rect.y - 1,
      edit.rect.x + edit.rect.w + 1,
      edit.rect.y + edit.rect.h + 1,
    ]);
    const left = Math.max(0, Math.floor(Math.min(firstX, secondX)));
    const top = Math.max(0, Math.floor(Math.min(firstY, secondY)));
    const right = Math.min(after.width, Math.ceil(Math.max(firstX, secondX)));
    const bottom = Math.min(after.height, Math.ceil(Math.max(firstY, secondY)));
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * after.width + x) * 4;
        data.set(before.data.subarray(offset, offset + 4), offset);
      }
    }
  }
  return { ...after, data } as ImageData;
}

function unmatchedDraws(expected: readonly DrawnImage[], actual: readonly DrawnImage[]): DrawnImage[] {
  const remaining = [...actual];
  return expected.filter((draw) => {
    const index = remaining.findIndex((candidate) => matches(draw, candidate));
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}

function failure(
  result: SweepResult,
  spec: RunSpec,
  check: string,
  reason: string,
): void {
  result.failures += 1;
  result.details.push(
    `TASK68 IMAGE SWEEP FAILURE ${result.file} | page ${spec.pageIndex + 1}`
    + ` | ${spec.label} | ${check} | ${reason}`,
  );
}

async function verifyRun(
  result: SweepResult,
  originalBytes: Uint8Array,
  pages: EditDocument['pages'],
  spec: RunSpec,
  cache: VerificationCache,
): Promise<number> {
  if (process.env.TASK68_IMAGE_SWEEP_PROGRESS === '1') {
    process.stdout.write(`TASK68 IMAGE SWEEP PROGRESS ${result.file} | ${spec.label} start\n`);
  }
  const document: EditDocument = { originalBytes, pages, edits: [...spec.edits] };
  const affectedRefs = new Set((cache.rawPages[spec.pageIndex] ?? []).flatMap((draw) => (
    rawCoverClaims(draw, spec.edits) && draw.ref ? [draw.ref.tag] : []
  )));
  const renderPages = new Set<number>([spec.pageIndex]);
  for (const [pageIndex, draws] of cache.rawPages.entries()) {
    if (draws.some((draw) => draw.ref && affectedRefs.has(draw.ref.tag))) renderPages.add(pageIndex);
  }
  // The baseline is the source file itself (renders, text and raw draws are cached from it),
  // so a second, cover-only export would never be read.
  const exported = await exportPdf(document);
  result.removed += exported.redaction.removedImages;
  result.skippedPages += exported.redaction.imageSkippedPages;
  result.outsideCover += exported.redaction.outsideCoverImages;
  result.unmatched += exported.redaction.unmatchedImages;

  if (exported.redaction.unmatchedImages !== 0) {
    failure(result, spec, 'C6', `${exported.redaction.unmatchedImages} unmatched image claim(s)`);
  }
  const outsideWarning = `A picture on page ${spec.pageIndex + 1} was not removed because the patch does not fully cover it; it is left as it was.`;
  const outsideWarnings = exported.warnings.filter((warning) => warning === outsideWarning).length;
  if (outsideWarnings !== exported.redaction.outsideCoverImages) {
    failure(
      result,
      spec,
      'C6',
      `${exported.redaction.outsideCoverImages} outside-cover draw(s) but ${outsideWarnings} warning(s)`,
    );
  }
  const skippedWarnings = exported.warnings.filter((warning) => (
    warning.startsWith(`Old images on page ${spec.pageIndex + 1} could not be removed;`)
  )).length;
  if (skippedWarnings < exported.redaction.imageSkippedPages) {
    failure(
      result,
      spec,
      'C6',
      `${exported.redaction.imageSkippedPages} skipped page(s) but ${skippedWarnings} warning(s)`,
    );
  }

  let outputReader: PDFDocumentProxy | undefined;
  try {
    outputReader = await getDocument({ data: exported.bytes.slice(), verbosity: 0 }).promise;
    if (pages.length !== outputReader.numPages) {
      failure(result, spec, 'C2', `page count changed ${pages.length}->${outputReader.numPages}`);
    }

    let baselineDrawCount = 0;
    let outputDrawCount = 0;
    const pageCount = Math.min(pages.length, outputReader.numPages);
    const verificationPages = [...renderPages]
      .filter((pageIndex) => pageIndex >= 0 && pageIndex < pageCount)
      .sort((left, right) => left - right);
    for (const pageIndex of verificationPages) {
      const afterPage = await outputReader.getPage(pageIndex + 1);
      let beforeState = cache.pages.get(pageIndex);
      let beforePage: PDFPageProxy | undefined;
      if (!beforeState) {
        beforePage = await cache.reader.getPage(pageIndex + 1);
        const [beforeOperators, beforeText] = await Promise.all([
          beforePage.getOperatorList({ annotationMode: 0 }),
          beforePage.getTextContent(),
        ]);
        beforeState = {
          draws: imageDrawsFromOperatorList(
            beforeOperators,
            beforePage.getViewport({ scale: 1, rotation: 0 }),
            pageIndex,
          ),
          text: textSnapshot(beforeText.items),
        };
        cache.pages.set(pageIndex, beforeState);
      }
      const [afterOperators, afterText] = await Promise.all([
        afterPage.getOperatorList({ annotationMode: 0 }),
        afterPage.getTextContent(),
      ]);
      const afterDraws = imageDrawsFromOperatorList(
        afterOperators,
        afterPage.getViewport({ scale: 1, rotation: 0 }),
        pageIndex,
      );
      baselineDrawCount += beforeState.draws.length;
      outputDrawCount += afterDraws.length;

      const edits = pageIndex === spec.pageIndex ? spec.edits : [];
      const unclaimed = beforeState.draws.filter((draw) => !coverClaims(draw, edits));
      const missingUnclaimed = unmatchedDraws(unclaimed, afterDraws);
      if (missingUnclaimed.length > 0) {
        failure(result, spec, 'C2', `${missingUnclaimed.length} unclaimed draw(s) changed on page ${pageIndex + 1}`);
      }
      if (
        pageIndex === spec.pageIndex
        && exported.redaction.imageSkippedPages === 0
        && exported.redaction.outsideCoverImages === 0
      ) {
        const claimed = beforeState.draws.filter((draw) => coverClaims(draw, spec.edits));
        const remainingClaimed = afterDraws.filter((draw) => (
          claimed.some((candidate) => matches(candidate, draw))
        ));
        if (remainingClaimed.length > 0) {
          failure(result, spec, 'C1', `${remainingClaimed.length} claimed draw(s) remain`);
        }
      }

      if (JSON.stringify(beforeState.text) !== JSON.stringify(textSnapshot(afterText.items))) {
        failure(result, spec, 'C5', `text strings or positions changed on page ${pageIndex + 1}`);
      }
      let beforeImage = cache.sourceRenders.get(pageIndex);
      if (!beforeImage) {
        beforePage ??= await cache.reader.getPage(pageIndex + 1);
        beforeImage = await renderPage(beforePage);
        cache.sourceRenders.set(pageIndex, beforeImage);
      }
      const afterImage = await renderPage(afterPage);
      // A pixel inside the cover's allowed one-point edge tolerance can blend with the hidden
      // image. The safety assertion is that removal changes nothing beyond that boundary.
      const comparedAfter = maskCoveredPixels(beforeImage, afterImage, afterPage, edits);
      const diff = worstBlockDiff(beforeImage, comparedAfter);
      if (diff.meanError >= 0.01) {
        failure(
          result,
          spec,
          'C4',
          `page ${pageIndex + 1} worst-block mean error ${diff.meanError.toFixed(6)}`,
        );
      }
      beforePage?.cleanup();
      afterPage.cleanup();
    }
    const drawDrop = baselineDrawCount - outputDrawCount;
    if (drawDrop !== exported.redaction.removedImages) {
      failure(
        result,
        spec,
        'C2',
        `draw count fell by ${drawDrop}, redaction reported ${exported.redaction.removedImages}`,
      );
    }
  } finally {
    await outputReader?.destroy();
  }

  const outputPdf = await PDFDocument.load(exported.bytes, { updateMetadata: false });
  const baselineRaw = cache.rawPages;
  const outputRaw = rawDraws(outputPdf);
  if (!outputRaw) {
    failure(result, spec, 'C3', 'raw image draws could not be decoded');
    return exported.redaction.removedImages;
  }
  const rawDrawDrop = baselineRaw.flat().length - outputRaw.flat().length;
  if (rawDrawDrop !== exported.redaction.removedImages) {
    failure(
      result,
      spec,
      'C2',
      `all-page raw draw count fell by ${rawDrawDrop}, redaction reported ${exported.redaction.removedImages}`,
    );
  }
  const stored = imageRefTags(outputPdf);
  const outputDrawnRefs = new Set(outputRaw.flatMap((draws) => (
    draws.flatMap((draw) => draw.ref ? [draw.ref.tag] : [])
  )));
  const claimedRefs = new Set((baselineRaw[spec.pageIndex] ?? []).flatMap((draw) => (
    rawCoverClaims(draw, spec.edits) && draw.ref ? [draw.ref.tag] : []
  )));
  for (const ref of claimedRefs) {
    if (outputDrawnRefs.has(ref) && !stored.has(ref)) {
      failure(result, spec, 'C3', `still-drawn image object ${ref} is missing from storage`);
    }
    if (!outputDrawnRefs.has(ref) && stored.has(ref)) {
      failure(result, spec, 'C3', `removed image object ${ref} remains in storage`);
    }
  }
  if (spec.sharedRef) {
    if (!stored.has(spec.sharedRef)) {
      failure(result, spec, 'C3', `shared image object ${spec.sharedRef} was deleted from storage`);
    }
    const otherPages = outputRaw.flatMap((draws, pageIndex) => (
      pageIndex === spec.pageIndex
        ? []
        : draws.filter((draw) => draw.ref?.tag === spec.sharedRef).map(() => pageIndex)
    ));
    if (otherPages.length === 0) {
      failure(result, spec, 'C3', `shared image object ${spec.sharedRef} no longer draws on another page`);
    }
  }
  if (process.env.TASK68_IMAGE_SWEEP_PROGRESS === '1') {
    process.stdout.write(`TASK68 IMAGE SWEEP PROGRESS ${result.file} | ${spec.label} end\n`);
  }
  return exported.redaction.removedImages;
}

function printResult(result: SweepResult): void {
  process.stdout.write(
    `TASK68 IMAGE SWEEP ${result.file} | pages ${result.pages} | candidates ${result.candidates}`
    + ` | removed ${result.removed} | stacked extras ${result.stackedExtras}`
    + ` | shared-object runs ${result.sharedObjectRuns} | skipped pages ${result.skippedPages}`
    + ` | outside-cover ${result.outsideCover} | unmatched ${result.unmatched}`
    + ` | failures ${result.failures} | ms ${result.ms}\n`,
  );
  for (const detail of result.details) process.stdout.write(`${detail}\n`);
}

(enabled ? describe : describe.skip)('Task 68 local image-deletion sweep', () => {
  it('removes only image draws hidden by covers across the full PDF corpus', async () => {
    const files = (await Promise.all(roots.map(pdfFiles))).flat().sort();
    const requestedFile = process.env.TASK68_IMAGE_SWEEP_FILE;
    const selectedFiles = requestedFile
      ? files.filter((file) => file.includes(requestedFile))
      : files;
    const total: SweepResult = {
      file: 'TOTAL', pages: 0, candidates: 0, removed: 0, stackedExtras: 0,
      sharedObjectRuns: 0, skippedPages: 0, outsideCover: 0, unmatched: 0,
      failures: 0, ms: 0, details: [],
    };
    const sweepStart = performance.now();
    const completedByHash = new Map<string, SweepResult>();

    for (const file of selectedFiles) {
      const started = performance.now();
      const result: SweepResult = {
        file, pages: 0, candidates: 0, removed: 0, stackedExtras: 0,
        sharedObjectRuns: 0, skippedPages: 0, outsideCover: 0, unmatched: 0,
        failures: 0, ms: 0, details: [],
      };
      let reader: PDFDocumentProxy | undefined;
      let loaded = false;
      try {
        const originalBytes = new Uint8Array(await readFile(file));
        const digest = createHash('sha256').update(originalBytes).digest('hex');
        const cached = completedByHash.get(digest);
        if (cached) {
          for (const key of [
            'pages', 'candidates', 'removed', 'stackedExtras', 'sharedObjectRuns',
            'skippedPages', 'outsideCover', 'unmatched', 'failures',
          ] as const) result[key] = cached[key];
        } else {
          const sourcePdf = await PDFDocument.load(originalBytes, { updateMetadata: false });
          const sourceRaw = rawDraws(sourcePdf);
          if (!sourceRaw) throw new Error('raw content streams could not be decoded');
          reader = await getDocument({ data: originalBytes.slice(), verbosity: 0 }).promise;
          loaded = true;
          result.pages = reader.numPages;
          const pages = await pageGeometry(reader);
          const cache: VerificationCache = {
            pages: new Map(),
            sourceRenders: new Map(),
            rawPages: sourceRaw,
            reader,
          };
          const scans: PageScan[] = [];
          for (let pageIndex = 0; pageIndex < reader.numPages; pageIndex += 1) {
            scans.push(await scanPage(await reader.getPage(pageIndex + 1), pageIndex));
          }
          result.candidates = scans.reduce((count, scan) => count + scan.candidates.length, 0);

          for (const scan of scans) {
            if (scan.candidates.length > 0) {
              const edits = scan.candidates.map((candidate, index) => (
                coverFor(scan.pageIndex, candidate, scan.candidateDraws, `task68-a-${scan.pageIndex}-${index}`)
              ));
              await verifyRun(result, originalBytes, pages, {
                label: 'Run A', pageIndex: scan.pageIndex, edits,
              }, cache);
            }
            const groups = stackedGroups(scan.allDraws);
            for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
              const group = groups[groupIndex]!;
              const candidate = scan.candidates.find((entry) => (
                entry.draw?.kind === group[0]?.kind
                && sameRect(entry.region.rect, group[0]!.region.rect)
              ));
              if (!candidate) {
                failure(
                  result,
                  { label: `Run B stack ${groupIndex + 1}`, pageIndex: scan.pageIndex, edits: [] },
                  'C1',
                  'stacked draw group has no editor candidate',
                );
                continue;
              }
              const removed = await verifyRun(result, originalBytes, pages, {
                label: `Run B stack ${groupIndex + 1}`,
                pageIndex: scan.pageIndex,
                edits: [coverFor(
                  scan.pageIndex,
                  candidate,
                  scan.candidateDraws,
                  `task68-b-${scan.pageIndex}-${groupIndex}`,
                )],
              }, cache);
              result.stackedExtras += Math.max(0, removed - 1);
            }
          }

          const uses = new Map<string, Set<number>>();
          for (const [pageIndex, draws] of sourceRaw.entries()) {
            for (const draw of draws) {
              if (!draw.ref) continue;
              const pagesForRef = uses.get(draw.ref.tag) ?? new Set<number>();
              pagesForRef.add(pageIndex);
              uses.set(draw.ref.tag, pagesForRef);
            }
          }
          for (const [ref, usedPages] of uses) {
            if (usedPages.size < 2) continue;
            const pageIndex = Math.min(...usedPages);
            const raw = sourceRaw[pageIndex]?.find((draw) => draw.ref?.tag === ref);
            const scan = scans[pageIndex];
            const candidate = raw && scan?.candidates.find((entry) => sameRect(entry.region.rect, raw.rect));
            if (!raw || !scan || !candidate) {
              failure(
                result,
                { label: `Run C ${ref}`, pageIndex, edits: [] },
                'C1',
                'shared image object has no editor candidate on its first page',
              );
              continue;
            }
            result.sharedObjectRuns += 1;
            await verifyRun(result, originalBytes, pages, {
              label: `Run C ${ref}`,
              pageIndex,
              edits: [coverFor(pageIndex, candidate, scan.candidateDraws, `task68-c-${ref}`)],
              sharedRef: ref,
            }, cache);
          }
          if (result.failures === 0) {
            completedByHash.set(digest, { ...result, details: [] });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (loaded) {
          // Once a file has loaded, any error is a real failure: never let it pass silently.
          result.failures += 1;
          result.details.push(
            `TASK68 IMAGE SWEEP FAILURE ${result.file} | whole file | C6 | could not be processed: ${message}`,
          );
        } else {
          // Unreadable fixtures (the corrupt repair-tool PDFs) stay in the file list with no runs.
          process.stdout.write(`TASK68 IMAGE SWEEP UNREADABLE ${result.file} | ${message}\n`);
        }
      } finally {
        await reader?.destroy();
      }
      result.ms = Math.round(performance.now() - started);
      printResult(result);
      for (const key of [
        'pages', 'candidates', 'removed', 'stackedExtras', 'sharedObjectRuns',
        'skippedPages', 'outsideCover', 'unmatched', 'failures',
      ] as const) total[key] += result[key];
      total.details.push(...result.details);
    }

    total.ms = Math.round(performance.now() - sweepStart);
    printResult(total);
    expect(total.unmatched).toBe(0);
    expect(total.details).toEqual([]);
    expect(total.ms).toBeLessThan(30 * 60 * 1_000);
  }, 30 * 60 * 1_000);
});
