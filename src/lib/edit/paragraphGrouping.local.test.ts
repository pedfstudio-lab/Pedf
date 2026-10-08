import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractTextRuns, groupRunsIntoBlocks, preserveEditedBlockPartitions, type TextBlock } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { exportPdf } from '@/lib/export/exportPdf';
import type { EditDocument } from '@/lib/export/types';
import { buildTextBlockEdits, coverRectsForTextBlock } from './buildTextEdits';
import { sourceSpansForTextBlock, effectiveTextSpanStyle } from './richText';
import { paragraphSeedText } from './paragraphSeed';
import { wrapTextSpansToLines, wrapTextToLines } from './textLayout';
import { finishTextEdit } from './textEditSession';
import { coversOriginalRect } from './coverMatch';

const resume = 'tmp/bullets/RAHUL_RAJPUT_RESUME.pdf';
const ladakh = 'tmp/compress-tests/ladakh-original.pdf';
const enabled = process.env.TASK74_REAL === '1' && existsSync(resume) && existsSync(ladakh);
async function readBlocks(bytes: Uint8Array, pageIndex: number) {
  const doc = await getDocument({ data: bytes.slice(), verbosity: 0, fontExtraProperties: true }).promise;
  try {
    const page = await doc.getPage(pageIndex + 1);
    const [runs, ruleLines, regions] = await Promise.all([
      extractTextRuns(page, pageIndex), detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex),
    ]);
    const options = { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] };
    const glyphs = new Map<string, Map<string, number>>();
    const operators = await page.getOperatorList();
    let fontRef = '';
    operators.fnArray.forEach((op, index) => {
      if (op === OPS.setFont) fontRef = String(operators.argsArray[index][0]);
      if (op !== OPS.showText) return;
      const widths = glyphs.get(fontRef) ?? new Map<string, number>();
      for (const glyph of operators.argsArray[index][0] as { unicode?: string; width?: number }[]) {
        if (glyph.unicode && glyph.width !== undefined) widths.set(glyph.unicode, glyph.width);
      }
      glyphs.set(fontRef, widths);
    });
    const pages: EditDocument['pages'] = [];
    for (let index = 0; index < doc.numPages; index += 1) {
      const source = await doc.getPage(index + 1);
      const [x1, y1, x2, y2] = source.view;
      pages.push({ pageIndex: index, widthPt: x2! - x1!, heightPt: y2! - y1!,
        rotation: ((source.rotate % 360) + 360) % 360 as 0, boxOffset: { x: x1!, y: y1! } });
    }
    return { blocks: groupRunsIntoBlocks(runs, options),
      legacy: groupRunsIntoBlocks(runs, { ...options, preserveParagraphSplits: true, preserveBulletTails: true }), pages, glyphs };
  } finally { await doc.destroy(); }
}
function session(block: TextBlock) {
  const text = paragraphSeedText(block);
  return { text, style: block.style, spans: sourceSpansForTextBlock(block, text),
    width: block.rect.w, height: block.rect.h, dx: 0, dy: 0 };
}
describe('Step 5c.2 soft-break export alignment', () => {
  for (const rich of [false, true]) {
    it.each(['left', 'center', 'right'] as const)(`${rich ? 'rich' : 'plain'} %s lines align on visible glyphs`, async (align) => {
      const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
      pdf.addPage([400, 400]).drawText('Original paragraph', { x: 40, y: 350, size: 12, font });
      const bytes = await pdf.save(), before = await readBlocks(bytes, 0), block = before.blocks[0]!;
      const text = 'golden sunset at Shanti Stupa';
      const width = font.widthOfTextAtSize('golden', 12) + 0.1;
      const spans = [{ text, bold: false, italic: false }];
      const lines = rich ? wrapTextSpansToLines(spans, width, (value) => font.widthOfTextAtSize(value, 12))
        : wrapTextToLines(text, width, (value) => font.widthOfTextAtSize(value, 12));
      const next = { ...session(block), text, spans: rich ? spans : undefined,
        style: { ...block.style, fontRef: undefined, fontName: 'Helvetica', fontSizePt: 12 },
        width, align, alignLeftPt: 40, alignWidthPt: width };
      const edits = buildTextBlockEdits(block, next, lines, 1);
      const exported = await exportPdf({ originalBytes: bytes, pages: before.pages, edits: [...edits.covers, ...edits.texts] });
      const after = await readBlocks(exported.bytes, 0);
      const actual = after.blocks.flatMap((entry) => entry.lines).sort((a, b) => b.baselineY - a.baselineY);
      expect(actual).toHaveLength(lines.length);
      actual.forEach((line, index) => {
        const value = typeof lines[index] === 'string' ? lines[index] as string : (lines[index] as { text: string }).text;
        expect(value).toBe(value.trim());
        expect(line.text).toBe(value);
        const visibleWidth = font.widthOfTextAtSize(value, 12);
        const offset = align === 'center' ? (width - visibleWidth) / 2 : align === 'right' ? width - visibleWidth : 0;
        expect(Math.abs(line.rect.x - (40 + offset))).toBeLessThanOrEqual(0.5);
      });
    });
  }
});

describe.runIf(enabled)('Step 5c.2 real paragraph round trips', () => {
  it('does not combine different rows of borderless corporate tables', { timeout: 120_000 }, async () => {
    const bytes = new Uint8Array(await readFile('tmp/text-doubling/corporate-edited-3.pdf'));
    const roles = await readBlocks(bytes, 34), names = await readBlocks(bytes, 35);
    expect(roles.blocks.some((block) => block.text.includes('President') && block.text.includes('Executive Director'))).toBe(false);
    expect(names.blocks.some((block) => block.text.includes('Ramesh') && block.text.includes('Dr. Marti'))).toBe(false);
    expect(names.blocks.some((block) => block.text.includes('Subrahmanyam') && block.text.includes('Total'))).toBe(false);
  });
  it.runIf(existsSync('tmp/pdfs/nmat-syllabus.pdf'))('opens the actual NMAT Quick Snapshot as one box, keeping its heading and note separate', { timeout: 120_000 }, async () => {
    const before = await readBlocks(new Uint8Array(await readFile('tmp/pdfs/nmat-syllabus.pdf')), 0);
    const snapshot = before.blocks.find((block) => block.text.startsWith('Total questions:'))!;
    expect(snapshot).toBeDefined();
    expect(snapshot.lines.map((line) => line.text)).toEqual([
      'Total questions: 108', 'Total marks: 360', 'Total duration: 120 minutes (2 hours)',
      'Sections: 3 (Language Skills, Quantitative Skills, Logical Reasoning)',
    ]);
    const heading = before.blocks.find((block) => block.text.includes('Quick Snapshot'))!;
    expect(heading.text).toBe('CONCEPT Quick Snapshot');
    expect(heading).not.toBe(snapshot);
    // Change 9 detaches this margin note from the preceding drawn-bullet list.
    const note = before.blocks.find((block) => block.text.includes('Order of sections is fixed'))!;
    expect(note.lines).toHaveLength(1);
    expect(before.legacy.find((block) => block.text.includes('Order of sections is fixed'))!.lines.length).toBeGreaterThan(1);
    expect(before.legacy.filter((block) => block.lines.some((line) => snapshot.lines.some((fact) => line.text === fact.text)))).toHaveLength(3);
    const initial = session(snapshot), commit = vi.fn();
    expect(finishTextEdit(initial, { ...initial }, commit, vi.fn())).toBe('cancelled');
    expect(commit).not.toHaveBeenCalled();
  });
  it('reopens a source-font-measured résumé ABOUT ME edit as one box', { timeout: 120_000 }, async () => {
    const bytes = new Uint8Array(await readFile(resume));
    const before = await readBlocks(bytes, 0);
    const block = before.blocks.find((block) => block.text.startsWith('Tourism professional'))!;
    expect(block).toBeDefined();
    const ownWidths = before.glyphs.get(block.style.fontRef!)!;
    expect(ownWidths).toBeDefined();
    const initial = session(block);
    const next = { ...initial, text: initial.text.replace(/^Tourism/u, 'Travel'), spans: initial.spans!.map((span, index) => (
      index === 0 ? { ...span, text: span.text.replace(/^Tourism/u, 'Travel') } : span
    )) };
    const lines = wrapTextSpansToLines(next.spans, next.width, (text, span) => [...text].reduce((sum, character) => {
      const own = before.glyphs.get(span.fontRef ?? block.style.fontRef!) ?? ownWidths;
      const width = own.get(character) ?? [...before.glyphs.values()].map((widths) => widths.get(character)).find((width) => width !== undefined);
      expect(width, `Own font has ${character}`).toBeDefined();
      return sum + width! * next.style.fontSizePt / 1000;
    }, 0));
    const edits = buildTextBlockEdits(block, next, lines, 1);
    const exported = await exportPdf({ originalBytes: bytes, pages: before.pages, edits: [...edits.covers, ...edits.texts] });
    await writeFile('tmp/pdfs/5c2-resume-roundtrip.pdf', exported.bytes);
    const after = await readBlocks(exported.bytes, 0);
    const reopened = after.blocks.find((block) => block.text.startsWith('Travel professional'))!;
    expect(reopened).toBeDefined();
    expect(paragraphSeedText(reopened)).toBe(next.text);
    expect(reopened.lines).toHaveLength(lines.length);
    process.stdout.write(`ABOUT ME: ${lines.length} exported lines -> one ${reopened.lines.length}-line box\n`);
  });
  it('keeps Highlights bold in a merged paragraph, its no-op and source-font-measured export', { timeout: 120_000 }, async () => {
    const bytes = new Uint8Array(await readFile(ladakh));
    const before = await readBlocks(bytes, 2);
    const block = before.blocks.find((block) => block.text.startsWith('Explore Leh'))!;
    expect(block.lines).toHaveLength(4);
    const initial = session(block);
    expect(initial.spans?.map((span) => span.text).join('')).toBe(initial.text);
    const boldText = initial.spans!.filter((span) => span.bold).map((span) => span.text).join('');
    expect(boldText).toContain('Highlights:');
    const commit = vi.fn(), cancel = vi.fn();
    expect(finishTextEdit(initial, { ...initial }, commit, cancel)).toBe('cancelled');
    expect(commit).not.toHaveBeenCalled();
    const pdf = await PDFDocument.create();
    const regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    // Match the reported UI case: append QA in the final phrase's existing style/font.
    const next = { ...initial, text: `${initial.text} QA`, spans: [...initial.spans!.slice(0, -1),
      { ...initial.spans!.at(-1)!, text: `${initial.spans!.at(-1)!.text} QA` }] };
    const lines = wrapTextSpansToLines(next.spans, next.width, (text, span) => {
      const style = effectiveTextSpanStyle(next.style, span);
      const own = before.glyphs.get(span.fontRef ?? '');
      if (own && [...text].every((character) => own.has(character))) {
        return [...text].reduce((width, character) => width + own.get(character)! * style.fontSizePt / 1000, 0);
      }
      return (style.bold ? bold : regular).widthOfTextAtSize(text, style.fontSizePt);
    });
    const edits = buildTextBlockEdits(block, next, lines, 1);
    const exported = await exportPdf({ originalBytes: bytes, pages: before.pages, edits: [...edits.covers, ...edits.texts] });
    await writeFile('tmp/pdfs/5c2-ladakh-bold.pdf', exported.bytes);
    const after = await readBlocks(exported.bytes, 2);
    const boldRuns = after.blocks.flatMap((block) => block.lines.flatMap((line) => line.runs))
      .filter((run) => run.style.bold).map((run) => run.text).join('').replace(/\s/gu, '');
    expect(boldRuns).toContain('Highlights:');
    expect(after.blocks.some((block) => paragraphSeedText(block).includes(' QA'))).toBe(true);
    const reopened = after.blocks.find((block) => block.text.startsWith('Explore Leh'))!;
    expect(paragraphSeedText(reopened)).toBe(next.text);
    expect(reopened.lines).toHaveLength(lines.length);
    expect(Math.max(...reopened.lines.map((line) => line.rect.x)) - Math.min(...reopened.lines.map((line) => line.rect.x))).toBeLessThanOrEqual(0.5);
  });
  it('keeps an old second-box edit anchored, with no new edit on a second Done', { timeout: 120_000 }, async () => {
    const before = await readBlocks(new Uint8Array(await readFile(ladakh)), 2);
    const old = before.legacy.find((block) => block.text.startsWith('monasteries to river'))!;
    expect(old).toBeDefined();
    const next = { ...session(old), text: 'Previously saved edit', spans: undefined };
    const edits = buildTextBlockEdits(old, next, [next.text], 1);
    const compatible = preserveEditedBlockPartitions(before.blocks, before.legacy, (block) => (
      edits.covers.some((cover) => coversOriginalRect(cover.rect, coverRectsForTextBlock(block)[0]!))
    ));
    const reopened = compatible.find((block) => block.text === old.text)!;
    // The same box, plus the page pitch its first edit used (the old copy
    // lacks it, so a reopen would otherwise switch line pitch).
    const { paragraphLineHeightPt, ...box } = reopened;
    expect(box).toEqual(old);
    const current = before.blocks.find((block) => block.lines.some((line) => line.text === old.lines[0]!.text));
    expect(paragraphLineHeightPt).toBe(current?.paragraphLineHeightPt);
    expect(coverRectsForTextBlock(reopened)).toEqual(coverRectsForTextBlock(old));
    const saved = { ...next, text: edits.texts[0]!.boxText!, width: edits.texts[0]!.rect.w };
    const commit = vi.fn();
    expect(finishTextEdit(saved, { ...saved }, commit, vi.fn())).toBe('cancelled');
    expect(commit).not.toHaveBeenCalled();
  });
});
