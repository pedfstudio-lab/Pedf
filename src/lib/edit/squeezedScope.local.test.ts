import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns, groupRunsIntoBlocks } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { startsWithBulletMarker } from '@/lib/pdf/textUnits';
import { calculateInitialEditorWidth } from './textEditSession';

// Probe: how many multi-line, left-aligned boxes have a line the PDF squeezed, i.e. whose
// plain glyph advances (normal spaces, no TJ/Tc/Tw) are wider than the box itself. Such a
// line cannot fit the box in the editor with normal spaces.
describe.runIf(process.env.SQUEEZE_SCOPE === '1')('squeezed lines scope', () => {
  it('corpus', { timeout: 3_600_000 }, async () => {
    const frozen = JSON.parse(await readFile('tmp/5d/source-text-before.json', 'utf8')) as Record<string, { pageIndex: number }[]>;
    const files = [...Object.keys(frozen), "tmp/paragraphs/Bhutan December'26.pdf", 'tmp/paragraphs/Corporate-Governance-edited (25).pdf'];
    let boxes = 0, squeezedBoxes = 0, squeezedLines = 0, measuredLines = 0, columnFailures = 0;
    const byFile: Record<string, { boxes: number; squeezed: number; worstPt: number; example?: string }> = {};
    const buckets = { '0.5-2pt': 0, '2-5pt': 0, '5-10pt': 0, '10pt+': 0 };
    for (const file of files) {
      if (!existsSync(file)) continue;
      const document = await getDocument({ data: new Uint8Array(await readFile(file)), verbosity: 0, fontExtraProperties: true }).promise;
      const entry = byFile[file] = { boxes: 0, squeezed: 0, worstPt: 0 } as { boxes: number; squeezed: number; worstPt: number; example?: string };
      for (let pageIndex = 0; pageIndex < document.numPages; pageIndex++) {
        const page = await document.getPage(pageIndex + 1);
        const [runs, ruleLines, regions] = await Promise.all([extractTextRuns(page, pageIndex), detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex)]);
        const blocks = groupRunsIntoBlocks(runs, { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] });
        for (const block of blocks) {
          if (block.lines.length < 2 || ((block.align ?? 'left') !== 'left' && block.align !== 'justify') || block.lines.some((line) => startsWithBulletMarker(line.text))) continue;
          boxes++; entry.boxes++;
          const column = calculateInitialEditorWidth({ blockWidthPt: block.rect.w, blockXPt: block.rect.x, fontSizePt: block.style.fontSizePt,
            measuredLineWidthPt: block.rect.w + 100, pageWidthPt: page.view[2]! - page.view[0]!, paragraphColumnWidthPt: block.rect.w });
          if (column !== block.rect.w) columnFailures++;
          let worst = 0, worstText = '';
          for (const line of block.lines) {
            const glyphs = line.runs.flatMap((run) => run.metrics?.glyphs ?? []);
            if (!glyphs.length || line.runs.some((run) => !run.metrics?.glyphs)) continue;
            measuredLines++;
            const natural = glyphs.reduce((sum, glyph) => sum + glyph.widthPt, 0)
              + (line.runs.length > 1 ? (line.runs.length - 1) * (line.runs[0]!.spaceWidthPt ?? line.style.fontSizePt * 0.25) : 0);
            const over = natural - block.rect.w;
            // A ratio far above 1 is a measurement artefact (e.g. Type3 glyph units), not a squeeze.
            const ratio = natural / Math.max(1, line.rect.w);
            if (over > 0.5 && ratio <= 1.2) { squeezedLines++; if (over > worst) { worst = over; worstText = `${line.text} [${(ratio * 100 - 100).toFixed(1)}% squeezed]`; } }
          }
          if (worst > 0.5) {
            squeezedBoxes++; entry.squeezed++;
            buckets[worst < 2 ? '0.5-2pt' : worst < 5 ? '2-5pt' : worst < 10 ? '5-10pt' : '10pt+']++;
            if (worst > entry.worstPt) { entry.worstPt = Number(worst.toFixed(1)); entry.example = `p${pageIndex + 1} "${worstText.slice(0, 50)}"`; }
          }
        }
      }
      await document.destroy();
    }
    const withSqueeze = Object.entries(byFile).filter(([, value]) => value.squeezed > 0);
    const summary = { files: Object.keys(byFile).length, filesWithSqueeze: withSqueeze.length, boxes, squeezedBoxes, measuredLines, squeezedLines, columnFailures, buckets,
      byFile: Object.fromEntries(withSqueeze.sort((a, b) => b[1].squeezed - a[1].squeezed)) };
    await writeFile('tmp/5d-review/squeezed-scope.json', JSON.stringify(summary, null, 2));
    process.stdout.write(`\nSQUEEZE ${JSON.stringify({ ...summary, byFile: undefined })}\n`);
    for (const [file, value] of withSqueeze) process.stdout.write(`  ${file}: ${value.squeezed}/${value.boxes} boxes, worst ${value.worstPt} pt ${value.example}\n`);
    expect(squeezedBoxes).toBe(738); expect(withSqueeze).toHaveLength(15); expect(columnFailures).toBe(0);
  });
});
