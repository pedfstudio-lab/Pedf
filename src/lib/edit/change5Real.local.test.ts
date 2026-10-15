import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { exportPdf } from '@/lib/export/exportPdf';
import type { TextSpan, TextStyle } from '@/lib/export/types';
import { paragraphSeedText } from './paragraphSeed';
import { paragraphPresentation } from './paragraphPresentation';
import { sourceSpansForTextBlock } from './richText';
import { buildTextBlockEdits, type NextTextEdit } from './buildTextEdits';
import { wrapTextParagraphs } from './paragraphLayout';
import { calculateInitialEditorWidth } from './textEditSession';

describe.runIf(process.env.TASK74_CHANGE5 === '1')('Change 5 real PDF model/export checks', () => {
  it('keeps Corporate p18 inside its column and preserves untouched glyphs on Ladakh p2', async () => {
    const reports = [];
    for (const [name, file, pageIndex, prefix] of [
      ['corporate', 'tmp/text-doubling/corporate-edited-3.pdf', 17, 'Common stockholders'],
      ['ladakh', 'tmp/compress-tests/ladakh-original.pdf', 1, 'Ladakh, for us'],
      ['ladakh-nights', 'tmp/compress-tests/ladakh-original.pdf', 1, 'And then there are'],
    ] as const) {
      const originalBytes = new Uint8Array(await readFile(file));
      const source = await getDocument({ data: originalBytes.slice(), verbosity: 0, fontExtraProperties: true }).promise;
      try {
        const page = await source.getPage(pageIndex + 1);
        const [runs, ruleLines, regions] = await Promise.all([extractTextRuns(page, pageIndex), detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex)]);
        const block = groupRunsIntoBlocks(runs, { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] }).find(block => block.text.startsWith(prefix));
        expect(block, prefix).toBeDefined(); if (!block) continue;
        const widths = new Map<string, number>();
        const key = (font: string | undefined, character: string) => JSON.stringify([font, character]);
        for (const run of runs) {
          for (const glyph of run.metrics?.glyphs ?? []) if ([...glyph.text].length === 1) widths.set(key(run.style.fontRef, glyph.text), glyph.widthPt / run.style.fontSizePt);
          if (run.spaceWidthPt) widths.set(key(run.style.fontRef, ' '), run.spaceWidthPt / run.style.fontSizePt);
        }
        // Source-glyph measurement, not a claim about browser-rendered metrics.
        const measure = (text: string, style: TextStyle) => [...text].reduce((sum, character) => sum + (widths.get(key(style.fontRef, character)) ?? 0.5) * style.fontSizePt, 0);
        const text = paragraphSeedText(block);
        const presentation = paragraphPresentation(block, text, block.style, 1, measure);
        expect((presentation.html.match(/data-pdf-source-row/g) ?? []).length, `${name}: source rows`).toBe(block.lines.length);
        const width = calculateInitialEditorWidth({ blockWidthPt: block.rect.w, blockXPt: block.rect.x, fontSizePt: block.style.fontSizePt,
          measuredLineWidthPt: block.rect.w + 16, pageWidthPt: page.view[2]!, paragraphColumnWidthPt: block.rect.w });
        expect(width).toBe(block.rect.w);
        let changed = text, spans: readonly TextSpan[] | undefined = sourceSpansForTextBlock(block, text, true);
        if (name === 'corporate') {
          changed = text.replace('Common stockholders', 'Common ordinary stockholders');
          spans = spans?.map(span => ({ ...span, text: span.text.replace('Common stockholders', 'Common ordinary stockholders') }));
          if (spans?.map(span => span.text).join('') !== changed) spans = undefined;
        } else {
          changed += 'S'; spans = spans?.map((span, index) => ({ ...span, text: span.text + (index === spans!.length - 1 ? 'S' : '') }));
        }
        const next: NextTextEdit = { text: changed, style: block.style, spans, width, height: block.rect.h, dx: 0, dy: 0,
          paragraphs: presentation.lines.map((_, index) => ({ gapBeforePt: index ? 0 : 0, firstIndentPt: 0, restIndentPt: 0 })),
          sourceParagraphLines: presentation.lines, preserveSourceWrapping: true,
          measurePiece: (text, style, piece) => {
            const value = measure(text, style), intrinsic = piece?.source?.glyphs?.reduce((sum, glyph) => sum + glyph.widthPt, 0);
            const old = piece ? measure(piece.text, style) : 0;
            return intrinsic !== undefined && old > 0 ? value * intrinsic / old : value;
          } };
        const wrapped = wrapTextParagraphs(next, (text, span) => measure(text, { ...block.style, ...span }), block);
        const built = buildTextBlockEdits(block, next, wrapped, 0);
        expect(built.texts.every(edit => !edit.composition || Math.max(...edit.composition.pieces.map(piece => piece.x + piece.widthPt)) <= block.rect.x + width + 0.5)).toBe(true);
        const pages = await Promise.all(Array.from({ length: source.numPages }, async (_, index) => {
          const page = await source.getPage(index + 1), [x = 0, y = 0, right = 0, top = 0] = page.view;
          return { pageIndex: index, widthPt: right - x, heightPt: top - y, rotation: page.rotate as 0 | 90 | 180 | 270, boxOffset: { x, y } };
        }));
        const exported = await exportPdf({ originalBytes, pages, edits: [...built.covers, ...built.texts] });
        const path = `tmp/5d-review/change5-${name}.pdf`; await writeFile(path, exported.bytes);
        const reader = await getDocument({ data: exported.bytes.slice(), verbosity: 0, fontExtraProperties: true }).promise;
        try {
          const after = await extractTextRuns(await reader.getPage(pageIndex + 1), pageIndex);
          const retained = built.texts.flatMap(edit => edit.composition?.pieces.filter(piece => piece.sourceVisible) ?? []);
          if (name === 'ladakh-nights') expect(retained.length, 'unchanged first paragraph must retain source glyphs').toBeGreaterThan(0);
          for (const piece of retained) expect(after.find(run => run.text === piece.text && run.metrics?.x === piece.source?.x && run.metrics?.baselineY === piece.source?.baselineY)?.rect).toEqual(piece.sourceRect);
          const changedArea = after.filter(run => run.rect.x >= block.rect.x - 0.5 && run.rect.x < block.rect.x + width + 0.5 && run.rect.y <= block.topBaselineY + 0.5 && run.rect.y >= block.rect.y - 20);
          const over = changedArea.filter(run => run.rect.x + run.rect.w > block.rect.x + width + 0.5);
          expect(over.map(run => run.text), `${name}: exported column overrun`).toEqual([]);
          reports.push({ name, path, page: pageIndex + 1, columnWidthPt: width, sourceRows: block.lines.length, savedRows: built.texts.length, retained: retained.length,
            presentationFallbacks: presentation.fallbacks, compositionFallbacks: built.texts.map(edit => edit.compositionFallback ?? null), exportedOverruns: over.length, warnings: exported.warnings });
        } finally { await reader.destroy(); }
      } finally { await source.destroy(); }
    }
    await writeFile('tmp/5d-review/change5-real-results.json', JSON.stringify(reports, null, 2));
  }, 180_000);
});
