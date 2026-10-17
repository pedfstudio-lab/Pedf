// Task 80 Fix B: measurement/prototype only. Nothing here is imported by the app.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns, groupRunsIntoBlocks, type TextLine } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { horizontalText } from '@/lib/pdf/textMetrics';
import { canUseSourceWord, matchFont, sourceFontWidth } from '@/lib/fonts/fontMatch';
import { loadFontBytes } from '@/lib/fonts/twinFonts';
import { sfntMetrics } from '@/lib/fonts/sfnt';
import type { TextStyle } from '@/lib/export/types';
import { effectiveTextSpanStyle, sourceSpansForTextBlock, splitParagraphSpans } from './richText';
import { sourceParagraphs } from './paragraphSeed';
import { wrapTextParagraphs } from './paragraphLayout';
import type { NextTextEdit } from './buildTextEdits';

function lineLetters(line: TextLine) {
  let pairs = 0, adjustmentPt = 0, additionalEm = 0, unavailableRuns = 0;
  for (const run of line.runs) {
    const metrics = run.metrics;
    if (!metrics?.glyphs || metrics.glyphs.some(glyph => [...glyph.text].length !== 1)
      || !horizontalText(metrics) || Math.abs((metrics.horizontalScale ?? 1) - 1) > 1e-6
      || Math.abs(metrics.matrix[0] / metrics.matrix[3] - 1) > 1e-4) { unavailableRuns++; continue; }
    for (const [index, glyph] of metrics.glyphs.entries()) {
      const previous = metrics.glyphs[index - 1];
      if (!previous || /\s/u.test(previous.text + glyph.text)) continue;
      const delta = glyph.offsetPt - previous.offsetPt - previous.widthPt;
      pairs++; adjustmentPt += delta;
      // Do not apply Task 78's page-wide tracking a second time.
      additionalEm += delta / run.style.fontSizePt - (run.style.fontTrackingEm ?? 0);
    }
  }
  return { text: line.text, baselineY: line.baselineY, pairs, adjustmentPt,
    averageEm: pairs ? adjustmentPt / (pairs * line.style.fontSizePt) : null,
    additionalEm: pairs ? additionalEm / pairs : null, unavailableRuns };
}

describe('Task 80 measurement arithmetic (not a production feature)', () => {
  const style: TextStyle = { fontName: 'Helvetica', fontSizePt: 10, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
  function sample(tracking = 0): TextLine {
    const rect = { x: 40, y: 700, w: 28, h: 10 }, paint = { ...style, fontTrackingEm: tracking };
    return { pageIndex: 0, text: 'AB CD', rect, baselineY: 700, style: paint,
      runs: [{ pageIndex: 0, text: 'AB CD', rect, style: paint, metrics: { matrix: [10, 0, 0, 10, 40, 700], x: 40, baselineY: 700, widthPt: 28,
        glyphs: [{ text: 'A', offsetPt: 0, widthPt: 5 }, { text: 'B', offsetPt: 4.9, widthPt: 5 },
          { text: ' ', offsetPt: 12, widthPt: 5 }, { text: 'C', offsetPt: 18, widthPt: 5 }, { text: 'D', offsetPt: 22.8, widthPt: 5 }] } }] };
  }
  it('counts only in-word seams, not the deliberately wider word gap', () => {
    const result = lineLetters(sample());
    expect(result.pairs).toBe(2); expect(result.adjustmentPt).toBeCloseTo(-0.3, 9);
    expect(result.additionalEm).toBeCloseTo(-0.015, 9);
  });
  it('subtracts the page tracking already applied by Task 78', () => {
    expect(lineLetters(sample(-0.015)).additionalEm).toBeCloseTo(0, 9);
  });
  it('treats missing glyphs and non-uniform matrices as unknown, not zero evidence', () => {
    const line = sample(), run = line.runs[0]!;
    expect(lineLetters({ ...line, runs: [{ ...run, metrics: undefined }] }).unavailableRuns).toBe(1);
    expect(lineLetters({ ...line, runs: [{ ...run, metrics: { ...run.metrics!, matrix: [9, 0, 0, 10, 40, 700] } }] }).pairs).toBe(0);
    expect(lineLetters({ ...line, runs: [{ ...run, metrics: { ...run.metrics!, glyphs: [{ text: 'fi', offsetPt: 0, widthPt: 5 }] } }] }).unavailableRuns).toBe(1);
  });
});

describe.runIf(process.env.TASK80_MEASURE === '1')('Task 80 Fix B Change 0', () => {
  it('measures all 47 PDFs and simulates one inserted word without changing production', async () => {
    const frozen = JSON.parse(await readFile('tmp/5d/source-text-before.json', 'utf8')) as Record<string, unknown>;
    const files = [...Object.keys(frozen), "tmp/paragraphs/Bhutan December'26.pdf", 'tmp/paragraphs/Corporate-Governance-edited (25).pdf'];
    expect(files).toHaveLength(47); expect(new Set(files).size).toBe(47);
    const fonts = new Map<string, ReturnType<typeof sfntMetrics>>();
    const measure = (text: string, style: TextStyle): number => (text.match(/\s+|\S+/gu) ?? []).reduce((sum, word) => {
      const match = matchFont(style), font = fonts.get(match.file)!;
      const own = canUseSourceWord(word, style) ? sourceFontWidth(word, style) : undefined;
      const width = own ?? [...word].reduce((n, c) => {
        const advance = font.width(c);
        if (advance === undefined) throw new Error(`Unmeasured character ${JSON.stringify(c)} in ${match.file}`);
        return n + advance;
      }, 0) * style.fontSizePt * match.scale;
      return sum + width + [...word].length * (style.fontTrackingEm ?? 0) * style.fontSizePt;
    }, 0);
    const rows = [], manifest = [];
    let pages = 0, blocks = 0;
    for (const file of files) {
      const bytes = new Uint8Array(await readFile(file));
      const reader = await getDocument({ data: bytes.slice(), fontExtraProperties: true, verbosity: 0 }).promise;
      manifest.push({ file, pages: reader.numPages, sha256: createHash('sha256').update(bytes).digest('hex') });
      try {
        for (let pageIndex = 0; pageIndex < reader.numPages; pageIndex++) {
          pages++;
          const page = await reader.getPage(pageIndex + 1);
          const [runs, ruleLines, regions] = await Promise.all([extractTextRuns(page, pageIndex), detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex)]);
          const justified = groupRunsIntoBlocks(runs, { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] }).filter(block => block.align === 'justify');
          blocks += justified.length;
          for (const [blockIndex, block] of justified.entries()) {
            const seed = sourceParagraphs(block);
            const paragraphSpans = splitParagraphSpans(sourceSpansForTextBlock(block, seed.text, true) ?? [{ text: seed.text, ...block.style }]);
            for (const [paragraph, lines] of seed.lines.entries()) {
              const spans = paragraphSpans[paragraph]!;
              for (const style of [block.style, ...spans.map(span => effectiveTextSpanStyle(block.style, span))]) {
                const match = matchFont(style);
                if (!fonts.has(match.file)) fonts.set(match.file, sfntMetrics(await loadFontBytes(match.file)));
              }
              const letters = lines.map(lineLetters);
              // Numerical epsilon only, not a visual size threshold. A line's net
              // in-word adjustment is averaged over its known within-word seams.
              const tightened = letters.filter(line => line.pairs && line.adjustmentPt < -1e-6);
              const limitEm = Math.min(0, ...letters.filter(line => line.pairs && line.unavailableRuns === 0).map(line => line.additionalEm!));
              const usableLimitEm = limitEm < -1e-7 ? limitEm : 0;
              const original = spans.map(span => span.text).join('');
              const word = original.startsWith('Common stockholders') ? 'ordinary' : 'extra';
              const offset = original.search(/\s/u);
              const insertion = offset < 0 ? original.length : offset;
              let cursor = 0, inserted = false;
              const editedSpans = spans.map(span => {
                const start = cursor; cursor += span.text.length;
                if (!inserted && cursor >= insertion) {
                  inserted = true; const at = insertion - start;
                  return { ...span, text: span.text.slice(0, at) + ` ${word}` + span.text.slice(at) };
                }
                return span;
              });
              const text = editedSpans.map(span => span.text).join('');
              const next: NextTextEdit = { text, spans: editedSpans, style: block.style, width: block.rect.w, height: block.rect.h,
                dx: 0, dy: 0, align: 'justify', paragraphs: [seed.layouts[paragraph]!] };
              const currentMeasure = (value: string, span: typeof spans[number]) => measure(value, effectiveTextSpanStyle(block.style, span));
              const before = wrapTextParagraphs(next, currentMeasure);
              // Diagnostic candidate-fit oracle, not shipped layout. Allow only
              // the source paragraph's residual contraction, inside words only.
              const candidateMeasure = (value: string, span: typeof spans[number]) => currentMeasure(value, span)
                + (value.match(/\S+/gu) ?? []).reduce((n, token) => n + Math.max(0, [...token].length - 1), 0)
                * usableLimitEm * effectiveTextSpanStyle(block.style, span).fontSizePt;
              const after = wrapTextParagraphs(next, candidateMeasure);
              if (!usableLimitEm) expect(after).toEqual(before);
              rows.push({ file, page: pageIndex + 1, block: blockIndex, paragraph, text: original, sourceLines: lines.length,
                sourceTightened: tightened.length > 0, tightenedLines: tightened.length,
                limitEm: usableLimitEm, limitPtAtBaseSize: usableLimitEm * block.style.fontSizePt,
                worstSourceLineAdjustmentPt: Math.min(0, ...letters.map(line => line.adjustmentPt)),
                sourceRowsWithoutCompleteMetrics: letters.filter(line => line.unavailableRuns).length,
                insertedWord: word, beforeLines: before.length, candidateLines: after.length,
                keptBefore: before.length === lines.length, keptCandidate: after.length === lines.length,
                beforeText: before.map(line => line.text), candidateText: after.map(line => line.text), lines: letters });
            }
          }
        }
      } finally { await reader.destroy(); }
      process.stdout.write(`TASK80 MEASURE ${file}\n`);
    }
    const affected = rows.filter(row => row.limitEm < 0);
    const summary = { files: files.length, pages, justifiedBlocks: blocks, paragraphs: rows.length,
      sourceTightenedParagraphs: rows.filter(row => row.sourceTightened).length,
      additionalTighteningParagraphs: affected.length, filesWithAdditionalTightening: new Set(affected.map(row => row.file)).size,
      unchangedParagraphs: rows.length - affected.length,
      keptLineCountBefore: affected.filter(row => row.keptBefore).length,
      keptLineCountCandidate: affected.filter(row => row.keptCandidate).length,
      recoveredLineCount: affected.filter(row => !row.keptBefore && row.keptCandidate).length,
      reducedLineCount: affected.filter(row => row.candidateLines < row.beforeLines).length,
      stillGrew: affected.filter(row => row.candidateLines > row.sourceLines).length };
    for (const file of manifest) expect(createHash('sha256').update(await readFile(file.file)).digest('hex'), file.file).toBe(file.sha256);
    await mkdir('tmp/task80', { recursive: true });
    await writeFile('tmp/task80/fix-b-change0.json', JSON.stringify({ summary, manifest, rows }, null, 2));
    const table = rows.filter(row => row.sourceTightened || row.limitEm < 0).map(row =>
      `| ${row.file} | ${row.page} | ${row.block}/${row.paragraph} | ${row.sourceLines} | ${row.worstSourceLineAdjustmentPt.toFixed(6)} | ${row.limitEm.toFixed(9)} | ${row.beforeLines} | ${row.candidateLines} | ${row.text.slice(0, 75).replaceAll('|', '\\|')} |`).join('\n');
    await writeFile('TASK80_FIX_B_CHANGE0_TABLE.md', `# Task 80 Fix B - Change 0 measurements\n\nMeasurement only; no Fix B production changes.\n\n${JSON.stringify(summary, null, 2)}\n\nOne inserted word after the first word: ordinary for Common stockholders, extra elsewhere. Matched-font nominal advances (no kerning), existing Task 78 tracking and Step 5d word-space limits. Candidate fit uses the tightest complete source line's mean in-word offset per em, less already-applied page tracking; it is a diagnostic capacity simulation, not browser/export acceptance. No squeeze of left/centre/right boxes, no detector change. Missing metrics are unknown, never zero evidence. Epsilon: 0.000001 pt to exclude floating-point noise.\n\n| File | Page | Justified box/paragraph | Source rows | Tightest source row net in-word pt | Additional limit em | Rows now | Candidate rows | Starts with |\n|---|---:|---|---:|---:|---:|---:|---:|---|\n${table}\n`);
    process.stdout.write(`TASK80 SUMMARY ${JSON.stringify(summary)}\n`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(row => row.text.startsWith('Common stockholders') && row.sourceLines === 24)).toBe(true);
  }, 1_800_000);
});
