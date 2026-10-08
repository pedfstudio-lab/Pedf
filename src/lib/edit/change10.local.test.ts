import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractTextRuns, groupRunsIntoBlocks, preserveEditedBlockPartitions } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { sourceParagraphs } from './paragraphSeed';
import { sourceSpansForTextBlock } from './richText';
import { wrapTextParagraphs } from './paragraphLayout';
import { buildTextBlockEdits } from './buildTextEdits';
import { exportPdf } from '@/lib/export/exportPdf';
const file = 'tmp/text-doubling/corporate-edited-3.pdf';
async function pageData(bytes: Uint8Array, pageIndex = 10) {
  const document = await getDocument({ data: bytes.slice(), verbosity: 0, fontExtraProperties: true }).promise;
  try {
    const page = await document.getPage(pageIndex + 1);
    const [runs, ruleLines, regions] = await Promise.all([extractTextRuns(page, pageIndex), detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex)]);
    const options = { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] };
    const blocks = groupRunsIntoBlocks(runs, options), old = groupRunsIntoBlocks(runs, { ...options, preserveParagraphGaps: true });
    const pages = await Promise.all(Array.from({ length: document.numPages }, async (_, pageIndex) => {
      const source = await document.getPage(pageIndex + 1), [x, y, right, top] = source.view;
      return { pageIndex, widthPt: right! - x!, heightPt: top! - y!, rotation: 0 as const, boxOffset: { x: x!, y: y! } };
    }));
    return { blocks, old, pages };
  } finally { await document.destroy(); }
}
describe.runIf(process.env.TASK74_REAL === '1' && existsSync(file))('Change 10 actual paragraph positions', () => {
  it('edits one word and keeps every unchanged line at its source baseline and x through export', async () => {
    const bytes = new Uint8Array(await readFile(file)), before = await pageData(bytes);
    const block = before.blocks.find(block => block.text.startsWith('(i) Transparency'))!;
    const seeded = sourceParagraphs(block), originalSpans = sourceSpansForTextBlock(block, seeded.text)!;
    const next = { text: seeded.text.replace('quality', 'clarity'), spans: originalSpans.map(span => ({ ...span, text: span.text.replace('quality', 'clarity') })),
      style: block.style, width: block.rect.w, height: block.rect.h, dx: 0, dy: 0, paragraphs: seeded.layouts, preserveSourceWrapping: true };
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.TimesRoman);
    const lines = wrapTextParagraphs(next, text => font.widthOfTextAtSize(text, next.style.fontSizePt), block);
    const built = buildTextBlockEdits(block, next, lines, 1);
    const exported = await exportPdf({ originalBytes: bytes, pages: before.pages, edits: [...built.covers, ...built.texts] });
    await writeFile('tmp/pdfs/change10-corporate-edited.pdf', exported.bytes);
    const after = await pageData(exported.bytes);
    for (const line of block.lines.filter(line => !line.text.includes('quality'))) {
      const found = after.blocks.flatMap(block => block.lines).find(next => next.text === line.text);
      expect(found, line.text).toBeDefined();
      expect(Math.abs(found!.baselineY - line.baselineY), line.text).toBeLessThanOrEqual(0.5);
      expect(Math.abs(found!.rect.x - line.rect.x), line.text).toBeLessThanOrEqual(0.5);
    }
    const reopened = after.blocks.find(block => block.text.startsWith('(i) Transparency'))!;
    expect(sourceParagraphs(reopened).layouts[2]!.firstIndentPt).toBeCloseTo(28.8, 1);
  }, 30_000);
  it('keeps the complete pre-Change-10 box when reopening an older saved edit', async () => {
    const before = await pageData(new Uint8Array(await readFile(file)));
    const old = before.old.find(block => block.text.startsWith('The fundamental'))!;
    expect(old.lines).toHaveLength(9);
    const preserved = preserveEditedBlockPartitions(before.blocks, before.old, block => block === old);
    expect(preserved.find(block => block.text.startsWith('The fundamental'))?.lines).toHaveLength(9);
  });
  it('keeps the travel note’s local leading, indentation and separate next note through export/re-edit', async () => {
    const bytes = new Uint8Array(await readFile('tmp/pdfs/task52-merge-qa/sample-goa-merged.pdf'));
    const before = await pageData(bytes, 3), block = before.blocks.find(block => block.text.startsWith('1. Check-in'))!;
    const seeded = sourceParagraphs(block), spans = sourceSpansForTextBlock(block, seeded.text)!;
    const next = { text: seeded.text.replace('hotel approval', 'hotel consent'), spans: spans.map(span => ({ ...span, text: span.text.replace('hotel approval', 'hotel consent') })),
      style: block.style, width: block.rect.w, height: block.rect.h, dx: 0, dy: 0, paragraphs: seeded.layouts, preserveSourceWrapping: true };
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const lines = wrapTextParagraphs(next, text => font.widthOfTextAtSize(text, next.style.fontSizePt), block);
    expect(lines).toHaveLength(3);
    const built = buildTextBlockEdits(block, next, lines, 1);
    for (let index = 0; index < built.texts.length; index += 1) {
      expect(Math.abs(built.texts[index]!.rect.y - block.lines[index]!.baselineY)).toBeLessThanOrEqual(0.5);
      expect(built.texts[index]!.rect.x).toBeCloseTo(block.lines[index]!.rect.x, 1);
    }
    const exported = await exportPdf({ originalBytes: bytes, pages: before.pages, edits: [...built.covers, ...built.texts] });
    const after = await pageData(exported.bytes, 3), reopened = after.blocks.find(block => block.text.startsWith('1. Check-in'))!;
    expect(reopened.text).toContain('hotel consent');
    expect(reopened.text).not.toContain('Full-Day Tours');
    expect(sourceParagraphs(reopened).layouts[1]!.firstIndentPt).toBeCloseTo(8.04, 1);
    expect(sourceParagraphs(reopened).layouts[1]!.restIndentPt).toBeCloseTo(8.04, 1);
  });
});
