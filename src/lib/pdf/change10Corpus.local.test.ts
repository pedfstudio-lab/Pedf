import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns, groupRunsIntoBlocks, type TextBlock, type TextLine } from './textContent';
import { detectRuleLines } from './ruleLines';
import { detectPageGraphicRegions } from './shapeMarkers';
import { detectBulletListFromRegions } from './bulletList';
import { biggerParagraphGap, inRuledColumn, pageLinePitches } from './paragraphPitch';
import { sourceParagraphs } from '@/lib/edit/paragraphSeed';
import { sourceSpansForTextBlock } from '@/lib/edit/richText';

const enabled = process.env.TASK74_GROUPING === '1' && existsSync('tmp/tables/baseline.json');
const reviewedDigest = 'fb6b2ba3da9d1b40b0db0df663d4964beb12e06b42171f81f91603d6324c2a69';
const key = (line: TextLine) => JSON.stringify([line.pageIndex, line.baselineY, line.rect.x, line.text]);
const pairs = (blocks: readonly TextBlock[]) => new Map(blocks.flatMap(block => block.lines.slice(1).map((line, index) => [JSON.stringify([key(block.lines[index]!), key(line)]), [block.lines[index]!, line]] as const)));
describe.runIf(enabled)('Change 10 live corpus', () => {
  it('classifies every new gap boundary and freezes every list and ruled cell', { timeout: 600_000 }, async () => {
    const baseline = JSON.parse(await readFile('tmp/tables/baseline.json', 'utf8')) as { files: Record<string, { pages: { pageIndex: number }[] }> };
    const files = [...Object.keys(baseline.files), 'tmp/ziro-check.pdf'].filter((file, index, array) => existsSync(file) && array.indexOf(file) === index);
    const splits: { file: string; page: number; upper: string; lower: string; gap: number; pitch: number; reason: string }[] = [];
    let beforeCount = 0, afterCount = 0, lists = 0, cells = 0;
    for (const file of files) {
      const document = await getDocument({ data: new Uint8Array(await readFile(file)), verbosity: 0, fontExtraProperties: true }).promise;
      try {
        for (const pageIndex of baseline.files[file]?.pages.map(page => page.pageIndex) ?? Array.from({ length: document.numPages }, (_, i) => i)) {
          const page = await document.getPage(pageIndex + 1);
          const [runs, ruleLines, regions] = await Promise.all([extractTextRuns(page, pageIndex), detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex)]);
          const options = { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] };
          const before = groupRunsIntoBlocks(runs, { ...options, preserveParagraphGaps: true }), after = groupRunsIntoBlocks(runs, options);
          const pitches = pageLinePitches(before.flatMap(block => block.lines));
          beforeCount += before.length; afterCount += after.length;
          const oldPairs = pairs(before), newPairs = pairs(after);
          expect([...newPairs.keys()].filter(pair => !oldPairs.has(pair)), `${file} p${pageIndex + 1}: no new joins`).toEqual([]);
          for (const [pair, [upper, lower]] of oldPairs) if (!newPairs.has(pair)) {
            const owner = before.find(block => block.lines.includes(upper))!;
            expect(owner.align).toBe('left'); expect(inRuledColumn(owner, ruleLines)).toBe(false);
            expect(biggerParagraphGap(upper, lower, pitches), `${file} p${pageIndex + 1}: measured pitch`).toBe(true);
            splits.push({ file, page: pageIndex + 1, upper: upper.text, lower: lower.text,
              gap: upper.baselineY - lower.baselineY, pitch: Math.max(pitches.get(upper) ?? 0, pitches.get(lower) ?? 0),
              reason: 'Separate left-aligned paragraphs/headings/items: source gap exceeds 1.3 times the repeated page pitch for their family/size.' });
          }
          const items = (blocks: readonly TextBlock[]) => blocks.map(block => detectBulletListFromRegions(block, regions.imageRegions, regions.shapeMarkerRegions)).filter(list => list !== null).map(list => list.items.map(item => item.text));
          const oldItems = items(before); lists += oldItems.length;
          expect(items(after), `${file} p${pageIndex + 1}: all list items`).toEqual(oldItems);
          for (const block of before.filter(block => block.align !== 'left' || inRuledColumn(block, ruleLines))) {
            if (inRuledColumn(block, ruleLines)) cells += 1;
            expect(after.some(next => next.text === block.text && JSON.stringify(next.rect) === JSON.stringify(block.rect)), `${file}: protected box`).toBe(true);
          }
          expect(after.flatMap(block => block.lines).map(key).sort(), `${file}: no text/geometry loss`).toEqual(before.flatMap(block => block.lines).map(key).sort());
          for (const block of after.filter(block => block.align === 'left')) {
            const seed = sourceParagraphs(block);
            const source = sourceSpansForTextBlock(block, block.text, true);
            if (source) expect(sourceSpansForTextBlock(block, seed.text, true)?.map(span => span.text).join(''), `${file}: rich paragraph seed`).toBe(seed.text);
          }
          if (file.endsWith('corporate-edited-3.pdf') && pageIndex === 10) {
            expect(after.find(block => block.text.startsWith('The fundamental'))?.lines).toHaveLength(1);
            const transparency = after.find(block => block.text.startsWith('(i) Transparency'))!;
            expect(transparency.lines).toHaveLength(8);
            const layouts = sourceParagraphs(transparency).layouts;
            expect(layouts).toHaveLength(3); expect(layouts[1]!.gapBeforePt).toBeCloseTo(3, 0);
            expect(layouts[2]!.gapBeforePt).toBeCloseTo(3, 0); expect(layouts[2]!.firstIndentPt).toBeCloseTo(28.8, 1);
          }
        }
      } finally { await document.destroy(); }
    }
    const digest = createHash('sha256').update(JSON.stringify(splits.map(({ file, page, upper, lower }) => [file, page, upper, lower]).sort())).digest('hex');
    const summary = { files: files.length, beforeCount, afterCount, splits: splits.length, lists, cells, digest };
    await writeFile('tmp/pdfs/change10-corpus.json', JSON.stringify({ summary, splits }, null, 2));
    process.stdout.write(JSON.stringify(summary) + '\n' + splits.map(split => `${split.file} p${split.page}: ${split.upper} / ${split.lower} — ${split.gap.toFixed(2)} > 1.3 × ${split.pitch.toFixed(2)}; ${split.reason}`).join('\n'));
    expect(lists).toBe(151); expect(digest, 'Freeze the classified gap report').toBe(reviewedDigest);
  });
});
