import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns, groupRunsIntoBlocks, mergeRunsIntoLines } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { sourceParagraphs } from './paragraphSeed';
import { paragraphPresentation } from './paragraphPresentation';
import { wrapTextParagraphs } from './paragraphLayout';
import { buildTextBlockEdits, type NextTextEdit } from './buildTextEdits';
import { exportPdf } from '@/lib/export/exportPdf';
import type { TextStyle } from '@/lib/export/types';

describe.runIf(process.env.TASK74_JUSTIFY === '1')('Change 4 approved rule and real reflow', () => {
  it('matches exactly the 314 approved boxes without changing extracted strings or partitions', async () => {
    const frozen = JSON.parse(await readFile('tmp/5d/source-text-before.json', 'utf8')) as Record<string, { pageIndex: number; lines: string[] }[]>;
    const approved = JSON.parse(await readFile('tmp/5d-review/justification-revised.json', 'utf8')) as { rows: { status: string; file: string; page: number; text: string }[] };
    const expected = approved.rows.filter(row => row.status === 'accepted').map(row => JSON.stringify([row.file, row.page, row.text])).sort();
    const actual: string[] = [];
    for (const [file, entries] of Object.entries(frozen)) {
      const document = await getDocument({ data: new Uint8Array(await readFile(file)), verbosity: 0, fontExtraProperties: true }).promise;
      try { for (const entry of entries) {
        const page = await document.getPage(entry.pageIndex + 1);
        const [runs, ruleLines, regions] = await Promise.all([extractTextRuns(page, entry.pageIndex), detectRuleLines(page, entry.pageIndex), detectPageGraphicRegions(page, entry.pageIndex)]);
        const options = { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] };
        expect(mergeRunsIntoLines(runs, options).map(line => line.text)).toEqual(entry.lines);
        const blocks = groupRunsIntoBlocks(runs, options);
        for (const block of blocks) if (block.align === 'justify') actual.push(JSON.stringify([file, entry.pageIndex + 1, block.text]));
      }} finally { await document.destroy(); }
      process.stdout.write(`JUSTIFY PARITY ${file}\n`);
    }
    await writeFile('tmp/5d-review/change4-classifier-parity.json', JSON.stringify({ accepted: actual.length, expected: expected.length, missing: expected.filter(key => !actual.includes(key)), extra: actual.filter(key => !expected.includes(key)) }, null, 2));
    expect(actual.sort()).toEqual(expected); expect(actual).toHaveLength(314);
  }, 1_800_000);
  it('Corporate p18 ordinary keeps 24 lines, a normal last line and clearance above Competition', async () => {
    const file = 'tmp/text-doubling/corporate-edited-3.pdf', pageIndex = 17, originalBytes = new Uint8Array(await readFile(file));
    const document = await getDocument({ data: originalBytes.slice(), verbosity: 0, fontExtraProperties: true }).promise;
    try {
      const page = await document.getPage(pageIndex + 1);
      const [runs, ruleLines, regions] = await Promise.all([extractTextRuns(page, pageIndex), detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex)]);
      const blocks = groupRunsIntoBlocks(runs, { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] });
      const block = blocks.find(block => block.text.startsWith('Common stockholders'))!;
      expect(block.align).toBe('justify'); expect(block.lines).toHaveLength(24);
      const directGaps: number[] = [];
      for (const run of block.lines.flatMap(line => line.runs)) {
        let previous: NonNullable<NonNullable<typeof run.metrics>['glyphs']>[number] | undefined, whitespace = false;
        for (const glyph of run.metrics?.glyphs ?? []) {
          if (/\s/u.test(glyph.text)) { whitespace = true; continue; }
          if (previous && whitespace) directGaps.push(glyph.offsetPt - previous.offsetPt - previous.widthPt);
          previous = glyph; whitespace = false;
        }
      }
      await writeFile('tmp/5d-review/change4-direct-gaps.json', JSON.stringify({ count: directGaps.length, min: Math.min(...directGaps), gaps: directGaps.sort((a,b)=>a-b).slice(0,10) }, null, 2));
      const widths = new Map<string, number>(), key = (font: string | undefined, character: string) => JSON.stringify([font, character]);
      for (const run of runs) {
        for (const glyph of run.metrics?.glyphs ?? []) if ([...glyph.text].length === 1) widths.set(key(run.style.fontRef, glyph.text), glyph.widthPt / run.style.fontSizePt);
        if (run.spaceWidthPt) widths.set(key(run.style.fontRef, ' '), run.spaceWidthPt / run.style.fontSizePt);
      }
      const measure = (text: string, style: TextStyle) => [...text].reduce((sum, c) => sum + (widths.get(key(style.fontRef, c)) ?? 0.5) * style.fontSizePt, 0);
      const original = sourceParagraphs(block), presentation = paragraphPresentation(block, original.text, block.style, 1, measure);
      const next: NextTextEdit = { text: original.text.replace('Common stockholders', 'Common ordinary stockholders'), style: block.style,
        width: block.rect.w, height: block.rect.h, dx: 0, dy: 0, align: 'justify', paragraphs: original.layouts,
        sourceParagraphLines: presentation.lines, measurePiece: measure, preserveSourceWrapping: true };
      const wrapped = wrapTextParagraphs(next, (text, span) => measure(text, { ...block.style, ...span }), block);
      await writeFile('tmp/5d-review/change4-gap-limit-probe.json', JSON.stringify([0.15, 0.145, 0.14, 0.13].map(minimumWordGapEm => ({ minimumWordGapEm, gapPt: minimumWordGapEm * block.style.fontSizePt,
        lines: wrapTextParagraphs({ ...next, sourceParagraphLines: undefined, paragraphs: next.paragraphs?.map(layout => ({ ...layout, minimumWordGapEm })) }, (text, span) => measure(text, { ...block.style, ...span }), block).length })), null, 2));
      const built = buildTextBlockEdits(block, next, wrapped, 1);
      const reflowOriginal = wrapTextParagraphs({ ...next, text: original.text, preserveSourceWrapping: false, sourceParagraphLines: undefined }, (text, span) => measure(text, { ...block.style, ...span }));
      await writeFile('tmp/5d-review/change4-corporate-model.json', JSON.stringify({ width: block.rect.w, layouts: original.layouts, sourceLines: block.lines.length,
        originalReflowLines: reflowOriginal.length, sourceLastLine: block.lines.at(-1)!.text, sourceLastLineNormalWidth: measure(block.lines.at(-1)!.text, block.style),
        sourceRows: block.lines.map(line => ({ text: line.text, width: line.rect.w, normalWidth: measure(line.text, block.style),
          minimumWidth: measure(line.text, block.style) - (line.text.match(/\s/gu)?.length ?? 0) * (2.485275 - 1.491165),
          runs: line.runs.map(run => ({ text: run.text, style: run.style, normalWidth: measure(run.text, run.style),
            intrinsicWidth: run.metrics?.glyphs?.reduce((sum, glyph) => sum + glyph.widthPt, 0),
            withinWordAdjustments: run.metrics?.glyphs?.flatMap((glyph, index, glyphs) => {
              const previous = glyphs[index - 1];
              return previous && !/\s/u.test(glyph.text + previous.text) ? [glyph.offsetPt - previous.offsetPt - previous.widthPt] : [];
            }).reduce((sum, value) => sum + value, 0),
            sourceGaps: run.wordSpacing?.spaces.map(gap => gap.gapPt) })) })),
        savedLines: built.texts.length, lines: built.texts.map(edit => ({ text: edit.text, y: edit.rect.y, pieces: edit.composition?.pieces })) }, null, 2));
      expect(built.texts).toHaveLength(24);
      for (const edit of built.texts.slice(0, -1)) expect(Math.max(...edit.composition!.pieces.map(piece => piece.x + piece.widthPt))).toBeCloseTo(block.rect.x + block.rect.w, 8);
      const competition = blocks.find(block => block.text.includes('1.10.4') && block.text.includes('Competition'))!;
      expect(built.texts.at(-1)!.rect.y).toBeGreaterThan(competition.rect.y + competition.rect.h);
      const pages = await Promise.all(Array.from({ length: document.numPages }, async (_, index) => {
        const page = await document.getPage(index + 1), [x = 0, y = 0, right = 0, top = 0] = page.view;
        return { pageIndex: index, widthPt: right - x, heightPt: top - y, rotation: page.rotate as 0 | 90 | 180 | 270, boxOffset: { x, y } };
      }));
      const exported = await exportPdf({ originalBytes, pages, edits: [...built.covers, ...built.texts] });
      await writeFile('tmp/5d-review/change4-corporate.pdf', exported.bytes);
    } finally { await document.destroy(); }
  }, 180_000);
});
