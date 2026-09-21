import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { buildTextBlockEdits, coverRectForTextLine } from '@/lib/edit/buildTextEdits';
import { exportPdf } from '@/lib/export/exportPdf';
import { imageDrawsFromOperatorList } from './images';
import type { PageGeometry } from './types';
import { extractTextRuns, groupRunsIntoBlocks, mergeRunsIntoLines } from './textContent';
import type { TextBlock, TextLine } from './textContent';

const roots = [
  'tmp/bullets', 'tmp/compress-tests', 'tmp/pdfs/task52-merge-qa',
  'tmp/pdfs/task53-split-qa', 'tmp/repair-tests', 'tmp/sign-tests',
  'tmp/text-doubling',
];
const enabled = process.env.TASK66_SWEEP === '1' && roots.some(existsSync);
if (!enabled) process.stdout.write('Task 66 local re-edit sweep skipped: set TASK66_SWEEP=1 with tmp/ test PDFs present.\n');
const openDocuments: PDFDocumentProxy[] = [];

interface FileResult {
  file: string;
  pages: number;
  flagged: number;
  passed: number;
  failed: number;
  untouched: number;
  textLines: number;
  removedItems: number;
  skippedPages: number;
  redactionFailures: number;
  removedImages: number;
  unmatchedImages: number;
  imageSkippedPages: number;
  imageRemovalFailures: number;
  sharedImageRectPages: number;
  reason?: string;
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

async function open(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const document = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  openDocuments.push(document);
  return document;
}

function pagesFor(document: PDFDocumentProxy): Promise<PageGeometry[]> {
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

function pairedLetters(text: string): boolean {
  const letters = text.replace(/[^a-z]/gi, '');
  return letters.length >= 8 && letters.length % 2 === 0 &&
    Array.from({ length: letters.length / 2 }, (_, index) => index * 2)
      .every((index) => letters[index] === letters[index + 1]);
}

function gluedRepeat(text: string): boolean {
  for (const line of text.split('\n')) {
    for (let length = 8; length <= Math.floor(line.length / 2); length++) {
      for (let start = 0; start + length * 2 <= line.length; start++) {
        if (line.slice(start, start + length) === line.slice(start + length, start + length * 2)) {
          return true;
        }
      }
    }
  }
  return false;
}

function nearLine(left: TextLine, right: TextLine): boolean {
  const tolerance = 4;
  return Math.abs(left.rect.x - right.rect.x) <= tolerance &&
    Math.abs(left.baselineY - right.baselineY) <= tolerance;
}

function asBlock(line: TextLine): TextBlock {
  return {
    pageIndex: line.pageIndex,
    text: line.text,
    rect: line.rect,
    topBaselineY: line.baselineY,
    lineHeightPt: line.style.fontSizePt * 1.2,
    style: line.style,
    lines: [line],
    align: line.align,
    alignLeftPt: line.alignLeftPt,
    alignWidthPt: line.alignWidthPt,
  };
}

function firstWord(text: string): string {
  return text.match(/[A-Za-z0-9]+/)?.[0] ?? 'TEXT';
}

function canFit(line: TextLine): boolean {
  const replacement = `EDIT THREE ${firstWord(line.text)}`;
  return line.rect.w / (replacement.length * 0.65) >= 6;
}

function isolatedFromOtherLines(line: TextLine, lines: readonly TextLine[]): boolean {
  const cover = coverRectForTextLine(line);
  return lines.every((other) => {
    if (other === line) return true;
    const width = Math.max(0, Math.min(cover.x + cover.w, other.rect.x + other.rect.w) - Math.max(cover.x, other.rect.x));
    const height = Math.max(0, Math.min(cover.y + cover.h, other.rect.y + other.rect.h) - Math.max(cover.y, other.rect.y));
    return width * height / Math.max(1, other.rect.w * other.rect.h) < 0.1;
  });
}

function selectLines(lines: readonly TextLine[]): TextLine[] {
  const eligible = lines.filter((line) => (
    line.text.trim().length >= 4 && canFit(line) && isolatedFromOtherLines(line, lines) &&
    lines.filter((candidate) => candidate.text === line.text).length === 1
  ));
  const bullet = eligible.filter((line) => /^[•▪◦‣-]\s*/u.test(line.text));
  const regular = eligible.filter((line) => !bullet.includes(line));
  const heading = [...regular].filter((line) => line.text.length <= 80)
    .sort((left, right) => right.style.fontSizePt - left.style.fontSizePt)[0];
  const paragraph = [...regular].filter((line) => line.text.length >= 32)
    .sort((left, right) => right.text.length - left.text.length)[0];
  const short = regular.find((line) => line.text.length <= 35);
  return [heading, paragraph, short, bullet[0]]
    .filter((line): line is TextLine => Boolean(line))
    .filter((line, index, selected) => selected.indexOf(line) === index);
}

async function pageLines(page: PDFPageProxy, pageIndex: number): Promise<TextLine[]> {
  return mergeRunsIntoLines(await extractTextRuns(page, pageIndex));
}

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function occurrenceCount(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function sameImageRect(
  left: ReturnType<typeof imageDrawsFromOperatorList>[number],
  right: ReturnType<typeof imageDrawsFromOperatorList>[number],
): boolean {
  const leftRect = left.region.rect;
  const rightRect = right.region.rect;
  const leftEdges = [leftRect.x, leftRect.y, leftRect.x + leftRect.w, leftRect.y + leftRect.h];
  const rightEdges = [rightRect.x, rightRect.y, rightRect.x + rightRect.w, rightRect.y + rightRect.h];
  return leftEdges.every((edge, index) => Math.abs(edge - (rightEdges[index] ?? edge)) <= 1);
}

async function reportSharedImageRects(
  file: string,
  page: PDFPageProxy,
  pageIndex: number,
  result: FileResult,
): Promise<void> {
  const draws = imageDrawsFromOperatorList(
    await page.getOperatorList({ annotationMode: 0 }),
    page.getViewport({ scale: 1, rotation: 0 }),
    pageIndex,
  );
  const pairs: string[] = [];
  for (let left = 0; left < draws.length; left += 1) {
    for (let right = left + 1; right < draws.length; right += 1) {
      if (sameImageRect(draws[left]!, draws[right]!)) pairs.push(`${left + 1}/${right + 1}`);
    }
  }
  if (pairs.length === 0) return;
  result.sharedImageRectPages += 1;
  process.stdout.write(
    `TASK68 SHARED IMAGE RECT ${file} p.${pageIndex + 1} | draw pairs ${pairs.join(', ')}\n`,
  );
}

async function rawPageText(document: PDFDocumentProxy, pageIndex: number): Promise<string> {
  const content = await (await document.getPage(pageIndex + 1)).getTextContent();
  return normalized(content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join(' '));
}

async function reeditLine(
  file: string,
  originalBytes: Uint8Array,
  originalDocument: PDFDocumentProxy,
  pageIndex: number,
  line: TextLine,
  result: FileResult,
): Promise<void> {
  const baseline = await pageLines(await originalDocument.getPage(pageIndex + 1), pageIndex);
  const word = firstWord(line.text);
  let bytes = originalBytes;
  let expected = line.text;
  for (const [generation, label] of ['ONE', 'TWO', 'THREE'].entries()) {
    const document = generation === 0 ? originalDocument : await open(bytes);
    const currentLines = await pageLines(await document.getPage(pageIndex + 1), pageIndex);
    const current = currentLines.find((candidate) => nearLine(line, candidate) && candidate.text === expected);
    if (!current) {
      result.failed += 1;
      result.details.push(`${file} p.${pageIndex + 1}: expected ${JSON.stringify(expected)} at ${line.rect.x.toFixed(1)},${line.baselineY.toFixed(1)} before Edit ${generation + 1}; got ${JSON.stringify(currentLines.filter((candidate) => nearLine(line, candidate)).map((candidate) => candidate.text))}`);
      return;
    }
    const replacement = `EDIT ${label} ${word}`;
    const style = {
      ...current.style,
      fontSizePt: Math.min(current.style.fontSizePt, current.rect.w / (replacement.length * 0.65)),
    };
    const built = buildTextBlockEdits(asBlock(current), {
      text: replacement,
      style,
      width: current.rect.w,
      height: current.rect.h,
      dx: 0,
      dy: 0,
      align: 'left',
    }, [replacement], 1);
    try {
      const exported = await exportPdf({
        originalBytes: bytes,
        edits: [...built.covers, ...built.texts],
        pages: await pagesFor(document),
      });
      result.removedItems += exported.redaction.removedItems;
      result.skippedPages += exported.redaction.skippedPages;
      result.removedImages += exported.redaction.removedImages;
      result.unmatchedImages += exported.redaction.unmatchedImages;
      result.imageSkippedPages += exported.redaction.imageSkippedPages;
      result.imageRemovalFailures += exported.redaction.imageSkippedPages
        + exported.redaction.unmatchedImages;
      bytes = exported.bytes;
      const reopened = await open(bytes);
      const raw = await rawPageText(reopened, pageIndex);
      const obsolete = [line.text, `EDIT ONE ${word}`, `EDIT TWO ${word}`].slice(0, generation + 1);
      const active = normalized(replacement);
      const stillPresent = obsolete.filter((text) => {
        const old = normalized(text);
        return occurrenceCount(raw, old) > occurrenceCount(active, old);
      });
      if (stillPresent.length > 0) {
        if (exported.redaction.skippedPages > 0) {
          result.details.push(`${file} p.${pageIndex + 1}: removal unavailable after Edit ${generation + 1}; raw text still has ${JSON.stringify(stillPresent)}; ${exported.warnings.join(' ')}`);
        } else {
          result.redactionFailures += 1;
          result.failed += 1;
          result.details.push(`${file} p.${pageIndex + 1}: raw old text remained after Edit ${generation + 1}: ${JSON.stringify(stillPresent)}`);
          return;
        }
      }
      const after = await pageLines(await reopened.getPage(pageIndex + 1), pageIndex);
      const atSpot = after.filter((candidate) => nearLine(line, candidate));
      if (atSpot.length !== 1 || atSpot[0]?.text !== replacement) {
        result.failed += 1;
        result.details.push(`${file} p.${pageIndex + 1}: ${JSON.stringify(expected)} → ${JSON.stringify(atSpot.map((candidate) => candidate.text))}; expected ${JSON.stringify(replacement)} once`);
        return;
      }
      const changed = baseline.filter((original) => {
        if (nearLine(line, original)) return false;
        return !after.some((candidate) => nearLine(original, candidate) && candidate.text === original.text);
      });
      result.untouched += changed.length;
      if (changed.length) result.details.push(`${file} p.${pageIndex + 1}: editing ${JSON.stringify(line.text)}, untouched lines changed after Edit ${generation + 1}: ${JSON.stringify(changed.slice(0, 4).map((candidate) => ({ original: candidate.text, after: after.filter((next) => nearLine(candidate, next)).map((next) => next.text) })))}`);
      expected = replacement;
    } catch (error) {
      result.failed += 1;
      result.details.push(`${file} p.${pageIndex + 1}: export failed for ${JSON.stringify(expected)}: ${String(error)}`);
      return;
    }
  }
  result.passed += 1;
}

afterEach(async () => {
  await Promise.all(openDocuments.splice(0).map((document) => document.destroy()));
});

describe.skipIf(!enabled)('Task 66 local re-edit sweep', () => {
  it('removes the reported Rahul name and CV contact line from source-built exports', async () => {
    const cases = [
      { file: 'tmp/bullets/Rahul_Resume.pdf.pdf', target: 'RAHUL RAJPUT' },
      { file: 'tmp/text-doubling/utkarsh-cv-edited.pdf', target: 'eddyutkarshteddy@gmail.com' },
    ];

    for (const { file, target } of cases) {
      const originalBytes = new Uint8Array(await readFile(file));
      const document = await open(originalBytes);
      const lines = await pageLines(await document.getPage(1), 0);
      const line = lines.find((candidate) => candidate.text.includes(target));
      expect(line, `${file} should contain ${target}`).toBeDefined();
      if (!line) continue;
      const result: FileResult = {
        file, pages: 1, flagged: 0, passed: 0, failed: 0, untouched: 0,
        textLines: lines.length, removedItems: 0, skippedPages: 0, redactionFailures: 0,
        removedImages: 0, unmatchedImages: 0, imageSkippedPages: 0, imageRemovalFailures: 0,
        sharedImageRectPages: 0, details: [],
      };

      await reeditLine(file, originalBytes, document, 0, line, result);
      process.stdout.write(
        `TASK67 TARGET ${file} | ${JSON.stringify(target)} | removed ${result.removedItems}`
        + ` | skipped ${result.skippedPages} | removed images ${result.removedImages}`
        + ` | unmatched images ${result.unmatchedImages}`
        + ` | image skipped ${result.imageSkippedPages}`
        + ` | round trips ${result.passed}/${result.passed + result.failed}\n`,
      );
      expect(result.details).toEqual([]);
      expect(result.failed).toBe(0);
      expect(result.redactionFailures).toBe(0);
      expect(result.imageRemovalFailures).toBe(0);
      expect(result.skippedPages).toBe(0);
      expect(result.removedItems).toBeGreaterThan(0);
      expect(result.passed).toBe(1);
    }
  }, 60_000);

  it('reads and re-edits every available tmp PDF three generations', async () => {
    const files = (await Promise.all(roots.map(pdfFiles))).flat().sort();
    const filter = process.env.TASK66_SWEEP_FILTER;
    const selected = filter ? files.filter((file) => file.includes(filter)) : files;
    const results: FileResult[] = [];

    for (const file of selected) {
      const result: FileResult = {
        file, pages: 0, flagged: 0, passed: 0, failed: 0, untouched: 0,
        textLines: 0, removedItems: 0, skippedPages: 0, redactionFailures: 0,
        removedImages: 0, unmatchedImages: 0, imageSkippedPages: 0, imageRemovalFailures: 0,
        sharedImageRectPages: 0, details: [],
      };
      results.push(result);
      let document: PDFDocumentProxy;
      let originalBytes: Uint8Array;
      try {
        originalBytes = new Uint8Array(await readFile(file));
        document = await open(originalBytes);
      } catch (error) {
        result.reason = `cannot open (${String(error)})`;
        process.stdout.write(`${file} | skipped: ${result.reason}\n`);
        continue;
      }

      for (let pageIndex = 0; pageIndex < Math.min(20, document.numPages); pageIndex++) {
        try {
          const page = await document.getPage(pageIndex + 1);
          await reportSharedImageRects(file, page, pageIndex, result);
          const blocks = groupRunsIntoBlocks(await extractTextRuns(page, pageIndex));
          result.pages += 1;
          const flagged = blocks.filter((block) => pairedLetters(block.text) || gluedRepeat(block.text));
          result.flagged += flagged.length;
          for (const block of flagged) {
            result.details.push(`${file} p.${pageIndex + 1}: doubled-text pattern ${JSON.stringify(block.text.slice(0, 120))}`);
          }
          if (pageIndex >= 2) continue;
          const lines = await pageLines(page, pageIndex);
          result.textLines += lines.length;
          for (const line of selectLines(lines)) {
            await reeditLine(file, originalBytes, document, pageIndex, line, result);
          }
        } catch (error) {
          result.reason = `page ${pageIndex + 1} cannot be read (${String(error)})`;
          result.details.push(`${file}: ${result.reason}`);
          break;
        }
      }
      if (result.passed === 0 && result.failed === 0 && !result.reason) {
        result.reason = result.textLines === 0
          ? 'no extractable text (scan or outlines)'
          : 'no safe isolated editable line (overlap or line too narrow)';
      }
      process.stdout.write(`${file} | pages ${result.pages} | flagged ${result.flagged} | round trips ${result.passed}/${result.passed + result.failed} | untouched ${result.untouched} | removed ${result.removedItems} | skipped ${result.skippedPages} | removed images ${result.removedImages} | unmatched images ${result.unmatchedImages} | image skipped ${result.imageSkippedPages} | shared-image-rect pages ${result.sharedImageRectPages}${result.reason ? ` | ${result.reason}` : ''}\n`);
      for (const detail of result.details) process.stdout.write(`  ${detail}\n`);
      await Promise.all(openDocuments.splice(0).map((opened) => opened.destroy()));
    }

    process.stdout.write(`TASK68 TOTAL files ${results.length}, pages ${results.reduce((sum, result) => sum + result.pages, 0)}, flagged ${results.reduce((sum, result) => sum + result.flagged, 0)}, round trips ${results.reduce((sum, result) => sum + result.passed, 0)} passed / ${results.reduce((sum, result) => sum + result.failed, 0)} failed, untouched ${results.reduce((sum, result) => sum + result.untouched, 0)}, removed text ${results.reduce((sum, result) => sum + result.removedItems, 0)}, text skipped ${results.reduce((sum, result) => sum + result.skippedPages, 0)}, removed images ${results.reduce((sum, result) => sum + result.removedImages, 0)}, unmatched images ${results.reduce((sum, result) => sum + result.unmatchedImages, 0)}, image skipped ${results.reduce((sum, result) => sum + result.imageSkippedPages, 0)}, shared-image-rect pages ${results.reduce((sum, result) => sum + result.sharedImageRectPages, 0)}, image-removal failures ${results.reduce((sum, result) => sum + result.imageRemovalFailures, 0)}\n`);
    expect(results.flatMap((result) => result.details.filter((detail) => detail.includes('expected') || detail.includes('export failed')))).toEqual([]);
    expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(0);
    expect(results.reduce((sum, result) => sum + result.untouched, 0)).toBe(0);
    expect(results.reduce((sum, result) => sum + result.redactionFailures, 0)).toBe(0);
    expect(results.reduce((sum, result) => sum + result.imageRemovalFailures, 0)).toBe(0);
    expect(results.reduce((sum, result) => sum + result.unmatchedImages, 0)).toBe(0);
    expect(results.reduce((sum, result) => sum + result.imageSkippedPages, 0)).toBe(0);
  }, 600_000);
});
