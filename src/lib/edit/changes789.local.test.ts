import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { detectBulletListFromRegions } from '@/lib/pdf/bulletList';
import { paragraphSeedText } from './paragraphSeed';
import { sourceSpansForTextBlock } from './richText';
import { buildTextBlockEdits } from './buildTextEdits';
import { wrapTextSpansToLines } from './textLayout';
import { exportPdf } from '@/lib/export/exportPdf';

const probe = 'tmp/grouping-probe/paragraph-grouping-test.pdf';
const enabled = process.env.TASK74_REAL === '1' && existsSync(probe);
async function load(bytes: Uint8Array, pageIndex: number) {
  const doc = await getDocument({ data: bytes.slice(), verbosity: 0, fontExtraProperties: true }).promise;
  try {
    const page = await doc.getPage(pageIndex + 1);
    const [runs, ruleLines, regions] = await Promise.all([extractTextRuns(page, pageIndex), detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex)]);
    const blocks = groupRunsIntoBlocks(runs, { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] });
    const pages = await Promise.all(Array.from({ length: doc.numPages }, async (_, pageIndex) => {
      const page = await doc.getPage(pageIndex + 1), [x, y, r, t] = page.view;
      return { pageIndex, widthPt: r! - x!, heightPt: t! - y!, rotation: 0 as const, boxOffset: { x: x!, y: y! } };
    }));
    return { runs, blocks, regions, pages, legacy: groupRunsIntoBlocks(runs, { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions], preserveFillerSplits: true, preserveBulletTails: true }) };
  } finally { await doc.destroy(); }
}
describe.runIf(enabled)('Changes 7–9 real PDF acceptance', () => {
  it('keeps the genuine outdented Ziro continuations in their lists', async () => {
    const file = 'tmp/image-removal/Ziro Festival Firgun-edited-edited (1).pdf';
    for (const pageIndex of [2, 3]) {
      const page = await load(new Uint8Array(await readFile(file)), pageIndex);
      const detect = (blocks: typeof page.blocks) => blocks.map(block => detectBulletListFromRegions(block, page.regions.imageRegions, page.regions.shapeMarkerRegions)).filter(list => list !== null);
      const before = detect(page.legacy), after = detect(page.blocks);
      expect(after.map(list => list.items.map(item => item.text))).toEqual(before.map(list => list.items.map(item => item.text)));
    }
  });
  it('matches all fifteen approved probe cases, keeping two columns separate', async () => {
    const bytes = new Uint8Array(await readFile(probe));
    const expected = [1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 2, 1, 2, 2, 1];
    for (const pageIndex of [0, 1]) {
      const { runs, blocks } = await load(bytes, pageIndex);
      const captions = runs.filter(run => /^CASE \d+:/u.test(run.text)).sort((a, b) => b.rect.y - a.rect.y);
      captions.forEach((caption, index) => {
        const caseNo = Number(caption.text.match(/^CASE (\d+)/u)![1]);
        const body = runs.filter(run => run.rect.y < caption.rect.y - 2 && run.rect.y > (captions[index + 1]?.rect.y ?? 0) + 2);
        const owners = blocks.filter(block => block.lines.some(line => line.runs.some(run => body.includes(run))));
        expect(body.length, `Case ${caseNo} has text`).toBeGreaterThan(0);
        expect(owners.length, `Case ${caseNo}`).toBe(expected[caseNo - 1]);
        if (caseNo === 1) expect(paragraphSeedText(owners[0]!)).toBe(owners[0]!.text);
        if (caseNo === 5) expect(paragraphSeedText(owners[0]!)).toBe('GUEST NAME\nMr. Pratik Sharma');
        if (caseNo === 7) expect(paragraphSeedText(owners[0]!)).toMatch(/^Board of Directors\nThe board/u);
        process.stdout.write(`CHANGE7 PROBE case ${caseNo}: ${owners.length} box(es)\n`);
      });
    }
  });
  it('edits one fact without collapsing the four lines, then exports/reopens one box', async () => {
    const bytes = new Uint8Array(await readFile(probe)), before = await load(bytes, 0);
    const block = before.blocks.find(block => block.text.startsWith('Total questions'))!;
    const seed = paragraphSeedText(block), text = seed.replace('questions', 'items');
    const spans = sourceSpansForTextBlock(block, seed) ?? [{ text: seed, bold: false, italic: false }];
    const nextSpans = spans.map(span => ({ ...span, text: span.text.replace('questions', 'items') }));
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.TimesRoman);
    const lines = wrapTextSpansToLines(nextSpans, block.rect.w, value => font.widthOfTextAtSize(value, block.style.fontSizePt));
    expect(lines.map(line => line.text)).toEqual(text.split('\n'));
    const built = buildTextBlockEdits(block, { text, spans: nextSpans, style: block.style, width: block.rect.w, height: block.rect.h, dx: 0, dy: 0 }, lines, 1);
    const exported = await exportPdf({ originalBytes: bytes, pages: before.pages, edits: [...built.covers, ...built.texts] });
    await writeFile('tmp/pdfs/5c2-789-facts-edited.pdf', exported.bytes);
    const after = await load(exported.bytes, 0), reopened = after.blocks.find(block => block.text.startsWith('Total items'))!;
    expect(reopened.lines.map(line => line.text)).toEqual(text.split('\n'));
    expect(reopened.lines.slice(1).map(line => line.rect)).toEqual(block.lines.slice(1).map(line => line.rect));
  });
  for (const file of ['tmp/nmat-check.pdf', 'tmp/pdfs/nmat-syllabus.pdf']) {
    it.runIf(existsSync(file))(`${file}: keeps the two notes outside their bullet lists`, async () => {
      const { blocks, regions } = await load(new Uint8Array(await readFile(file)), 0);
      const lists = blocks.map(block => detectBulletListFromRegions(block, regions.imageRegions, regions.shapeMarkerRegions)).filter(list => list !== null);
      expect(lists).toHaveLength(3);
      for (const prefix of ['Order of sections is fixed', 'Scaled score range:']) {
        expect(lists.flatMap(list => list.items).some(item => item.text.includes(prefix))).toBe(false);
        expect(blocks.find(block => block.text.startsWith(prefix))?.lines).toHaveLength(1);
      }
    });
  }
});
