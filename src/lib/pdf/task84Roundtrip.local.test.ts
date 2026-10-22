import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { attachedOrdinals, hasInlineOrdinal, ordinalRemovalCovers } from './attachedOrdinals';
import { extractTextRuns, groupRunsIntoBlocks } from './textContent';
import { detectRuleLines } from './ruleLines';
import { detectPageGraphicRegions } from './shapeMarkers';
import { sourceParagraphs } from '@/lib/edit/paragraphSeed';
import { effectiveTextSpanStyle, sourceSpansForTextBlock } from '@/lib/edit/richText';
import { wrapTextParagraphs } from '@/lib/edit/paragraphLayout';
import { buildTextBlockEdits, type NextTextEdit } from '@/lib/edit/buildTextEdits';
import { exportPdf } from '@/lib/export/exportPdf';
import { buildPageStreamTree } from '@/lib/export/formStreams';
import { planCoveredGlyphRemoval, type ContentStreamNode } from '@/lib/export/coveredGlyphs';
import { nameValue, serializeContentStream, textShowOperators, type ContentToken } from '@/lib/export/contentStream';
import { matchFont } from '@/lib/fonts/fontMatch';
import { loadFontBytes } from '@/lib/fonts/twinFonts';
import { sfntMetrics } from '@/lib/fonts/sfnt';
import type { TextStyle } from '@/lib/export/types';

const compact = (value: string) => value.replace(/\s+/gu, '');
const fixtures = [['tmp/text-doubling/ziro.pdf', 1], ['tmp/compress-tests/healing.pdf', 1],
  ['tmp/compress-tests/healing.pdf', 17], ['tmp/compress-tests/ladakh-original.pdf', 1]] as const;
function nodes(roots: readonly ContentStreamNode[]) {
  const result = new Map<string, readonly ContentToken[]>();
  const visit = (node: ContentStreamNode) => {
    if (result.has(node.key)) return; result.set(node.key, node.tokens);
    node.tokens.forEach((token, index) => {
      if (token.kind !== 'word' || token.value !== 'Do') return;
      const previous = node.tokens.slice(0, index).reverse().find(value => value.kind !== 'whitespace' && value.kind !== 'comment');
      const name = previous && nameValue(previous), child = name ? node.form(name) : null;
      if (child) visit(child);
    });
  };
  roots.forEach(visit); return result;
}

describe.runIf(process.env.TASK84_REAL === '1')('Task 84 real PDF save/reopen', () => {
  it('moves and edits every measured date, removing raised copies but not unrelated operators', async () => {
    await mkdir('tmp/task84/exports', { recursive: true });
    const results: Record<string, unknown>[] = [], failures: string[] = [];
    const fonts = new Map<string, ReturnType<typeof sfntMetrics>>();
    for (const [file, pageNumber] of fixtures) {
      const bytes = new Uint8Array(await readFile(file));
      const reader = await getDocument({ data: bytes.slice(), fontExtraProperties: true, verbosity: 0 }).promise;
      try {
        const page = await reader.getPage(pageNumber), pageIndex = pageNumber - 1;
        const runs = await extractTextRuns(page, pageIndex);
        const [ruleLines, regions] = await Promise.all([detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex)]);
        const blocks = groupRunsIntoBlocks(runs, { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] });
        const plans = attachedOrdinals(blocks, runs);
        expect(plans.flatMap(plan => plan.ordinals)).toHaveLength(2);
        const original = await PDFDocument.load(bytes, { updateMetadata: false }), tree = buildPageStreamTree(original, pageIndex)!;
        const beforeNodes = nodes(tree.roots);
        for (const [planIndex, plan] of plans.entries()) {
          const seed = sourceParagraphs(plan.editor), originalSpans = sourceSpansForTextBlock(plan.editor, seed.text, true)!;
          expect(originalSpans).toBeDefined();
          for (const style of [plan.editor.style, ...originalSpans.map(span => effectiveTextSpanStyle(plan.editor.style, span))]) {
            const match = matchFont(style);
            if (!fonts.has(match.file)) fonts.set(match.file, sfntMetrics(await loadFontBytes(match.file)));
          }
          const measure = (text: string, style: TextStyle) => {
            const match = matchFont(style);
            return [...text].reduce((sum, character) => sum + (fonts.get(match.file)!.width(character) ?? 0.5), 0) * style.fontSizePt * match.scale
              + [...text].length * (style.fontTrackingEm ?? 0) * style.fontSizePt;
          };
          for (const action of ['move', 'type'] as const) {
            const record: Record<string, unknown> = { file, page: pageNumber, plan: planIndex, action, original: seed.text };
            try {
              const first = plan.ordinals[0]!, number = String(Number(first.number) + 1);
              const suffix = /1$/u.test(number) && !/11$/u.test(number) ? 'st' : /2$/u.test(number) && !/12$/u.test(number) ? 'nd'
                : /3$/u.test(number) && !/13$/u.test(number) ? 'rd' : 'th';
              let changedNumber = false, changedSuffix = false;
              const spans = action === 'move' ? originalSpans : originalSpans.map(span => {
                if (!changedNumber && span.text.includes(first.number)) { changedNumber = true; return { ...span, text: span.text.replace(first.number, number) }; }
                if (!changedSuffix && span.text === first.text) { changedSuffix = true; return { ...span, text: suffix }; }
                return span;
              });
              const next: NextTextEdit = { text: spans.map(span => span.text).join(''), style: plan.editor.style, spans,
                paragraphs: seed.layouts, width: plan.editor.rect.w, height: plan.editor.rect.h, dx: action === 'move' ? 8 : 0,
                dy: action === 'move' ? -6 : 0, align: plan.editor.align, measurePiece: measure,
                ...(plan.editor.align === 'center' || plan.editor.align === 'right' ? { alignLeftPt: plan.editor.rect.x, alignWidthPt: plan.editor.rect.w } : {}) };
              const wrapped = wrapTextParagraphs(next, (text, span) => measure(text, effectiveTextSpanStyle(next.style, span)), plan.editor);
              const built = buildTextBlockEdits(plan.editor, next, wrapped, 1);
              const covers = ordinalRemovalCovers(plan, buildTextBlockEdits(plan.source, next, [], 1).covers, built.texts);
              const texts = built.texts.map((text, index) => ({ ...text, z: 1 + covers.length + index }));
              const removal = planCoveredGlyphRemoval((await page.getTextContent()).items, await page.getOperatorList({ annotationMode: 0 }),
                page.getViewport({ scale: 1, rotation: 0 }), tree.roots, covers);
              expect(removal.skipped).toBe(false); expect(removal.satisfied.every(Boolean)).toBe(true);
              const pages = original.getPages().map((source, index) => {
                const box = source.getCropBox();
                return { pageIndex: index, widthPt: box.width, heightPt: box.height, rotation: 0 as const, boxOffset: { x: box.x, y: box.y } };
              });
              const output = await exportPdf({ originalBytes: bytes, pages, edits: [...covers, ...texts] });
              expect(output.redaction.skippedPages).toBe(0);
              if (file.includes('healing') && pageNumber === 1 && action === 'move') {
                // Diagnostic: removing every editable date glyph without drawing
                // replacement text exposes any non-text artwork shadow underneath.
                const clean = await exportPdf({ originalBytes: bytes, pages, edits: covers });
                await writeFile('tmp/task84/exports/healing-p1-text-removed.pdf', clean.bytes);
                const reader = await getDocument({ data: clean.bytes.slice(), verbosity: 0 }).promise;
                try {
                  const remaining = await extractTextRuns(await reader.getPage(1), 0);
                  expect(remaining.some(run => /June|^(20|22|th|nd)$/u.test(run.text.trim()))).toBe(false);
                } finally { await reader.destroy(); }
              }
              const path = `tmp/task84/exports/${file.includes('ziro') ? 'ziro' : file.includes('ladakh') ? 'ladakh' : 'healing'}-p${pageNumber}-${planIndex}-${action}.pdf`;
              await writeFile(path, output.bytes);
              const reopened = await getDocument({ data: output.bytes.slice(), fontExtraProperties: true, verbosity: 0 }).promise;
              try {
                const changedPage = await reopened.getPage(pageNumber), after = await extractTextRuns(changedPage, pageIndex);
                const expected = compact(next.text), extracted = compact(after.map(run => run.text).join(''));
                const [rules, graphics] = await Promise.all([detectRuleLines(changedPage, pageIndex), detectPageGraphicRegions(changedPage, pageIndex)]);
                const afterBlocks = groupRunsIntoBlocks(after, { ruleLines: rules, markers: [...graphics.imageRegions, ...graphics.shapeMarkerRegions] });
                Object.assign(record, { expected, extracted, dateBlocks: afterBlocks.filter(block => /booked|May|September|August|June|GST/iu.test(block.text)).map(block => ({ text: block.text, rect: block.rect })),
                  dateRuns: after.filter(run => /booked|May|GST|^(?:th|rd|nd|st|2[567])$/iu.test(run.text)).map(run => ({ text: run.text, rect: run.rect })) });
                // Stationary rows stay in their original PDF operators while the
                // changed row is appended. Judge reading order by the unchanged
                // page grouping, not by content-stream insertion order.
                const logical = compact(afterBlocks.map(block => block.text).join(''));
                expect(logical).toContain(expected);
                expect(logical.split(expected).length - 1).toBe(1);
                for (const old of plan.ordinals.flatMap(value => value.copies)) {
                  expect(after.some(run => run.text.trim() === old.text.trim()
                    && Math.hypot(run.rect.x - old.rect.x, run.rect.y - old.rect.y) < Math.max(1, old.style.fontSizePt * 0.15))).toBe(false);
                }
                const reopenedDate = afterBlocks.find(block => compact(block.text).includes(expected));
                expect(reopenedDate, 'one re-editable date block with its suffixes').toBeDefined();
                const inline = reopenedDate!.lines.flatMap(line => line.runs)
                  .filter(run => /^(?:st|nd|rd|th)$/iu.test(run.text.trim()));
                expect(inline, 'each small ordinal appears once in the exported date').toHaveLength(plan.ordinals.length);
                expect(hasInlineOrdinal(reopenedDate!)).toBe(true);
                expect(attachedOrdinals(afterBlocks, after).some(value => compact(value.editor.text).includes(expected))).toBe(false);
                const afterPdf = await PDFDocument.load(output.bytes, { updateMetadata: false });
                const afterTree = buildPageStreamTree(afterPdf, pageIndex)!, afterNodes = nodes(afterTree.roots);
                const payloads = [...afterNodes.values()].flatMap(tokens => textShowOperators(tokens).map(op =>
                  Buffer.from(serializeContentStream(tokens.slice(op.operandStartTokenIndex, op.operatorTokenIndex + 1))).toString('hex')));
                let untouched = 0;
                for (const [key, tokens] of beforeNodes) for (const op of textShowOperators(tokens)) {
                  if (removal.rewrites.some(rewrite => rewrite.streamKey === key && rewrite.operatorOrdinal === op.ordinal)) continue;
                  const raw = Buffer.from(serializeContentStream(tokens.slice(op.operandStartTokenIndex, op.operatorTokenIndex + 1))).toString('hex');
                  const index = payloads.indexOf(raw); expect(index, 'untouched text-show bytes').toBeGreaterThanOrEqual(0); payloads.splice(index, 1); untouched++;
                }
                Object.assign(record, { status: 'passed', text: next.text, path, untouched, ordinalCopiesRemoved: plan.ordinals.reduce((sum, value) => sum + value.copies.length, 0) });
              } finally { await reopened.destroy(); }
            } catch (error) { Object.assign(record, { status: 'failed', error: String(error) }); failures.push(`${file} p${pageNumber} ${planIndex} ${action}: ${String(error)}`); }
            results.push(record);
            await writeFile('tmp/task84/roundtrips.json', JSON.stringify({ results, failures }, null, 2));
            process.stdout.write(JSON.stringify(record) + '\n');
          }
        }
      } finally { await reader.destroy(); }
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
