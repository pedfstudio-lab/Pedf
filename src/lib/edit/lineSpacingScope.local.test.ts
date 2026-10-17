import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns, groupRunsIntoBlocks, type TextBlock } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { startsWithBulletMarker } from '@/lib/pdf/textUnits';
import { sourceParagraphLineHeight, sourceParagraphs } from './paragraphSeed';

// Frozen pre-Fix-A rule. Keep independent of the production implementation.
function previousLineHeight(block: TextBlock): number {
  const bins = new Map<number, number[]>();
  block.lines.slice(1).forEach((line, index) => {
    const gap = block.lines[index]!.baselineY - line.baselineY;
    if (gap <= 0.5) return;
    const key = Math.round(gap * 2); bins.set(key, [...(bins.get(key) ?? []), gap]);
  });
  const values = [...bins].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0]?.[1];
  if (values && values.length >= 2) return values.reduce((a, b) => a + b, 0) / values.length;
  return block.paragraphLineHeightPt || (values?.length ? values.reduce((a, b) => a + b, 0) / values.length : block.lineHeightPt);
}

// Probe (Task 80 Fix A scope): boxes whose editor line spacing (the most common step between
// lines) differs from the spacing between lines INSIDE a paragraph — e.g. Corporate p13, where
// paragraph starts (16 pt) outnumber wrapped lines (12 pt) and every line opens 16 pt apart.
describe.runIf(process.env.SPACING_SCOPE === '1')('line spacing scope', () => {
  it('corpus', { timeout: 3_600_000 }, async () => {
    const frozen = JSON.parse(await readFile('tmp/5d/source-text-before.json', 'utf8')) as Record<string, unknown>;
    const files = [...Object.keys(frozen), "tmp/paragraphs/Bhutan December'26.pdf", 'tmp/paragraphs/Corporate-Governance-edited (25).pdf'];
    let boxes = 0, changed = 0, extraHeight = 0;
    let unchanged = 0, pages = 0;
    const changes: unknown[] = [];
    const byFile: Record<string, { changed: number; example: string }> = {};
    for (const file of files) {
      const document = await getDocument({ data: new Uint8Array(await readFile(file)), verbosity: 0, fontExtraProperties: true }).promise;
      try {
      for (let pageIndex = 0; pageIndex < document.numPages; pageIndex++) {
        pages++;
        const page = await document.getPage(pageIndex + 1);
        const [runs, ruleLines, regions] = await Promise.all([extractTextRuns(page, pageIndex), detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex)]);
        for (const block of groupRunsIntoBlocks(runs, { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] })) {
          if (block.lines.length < 3 || ((block.align ?? 'left') !== 'left' && block.align !== 'justify')) continue;
          if (block.lines.some((line) => startsWithBulletMarker(line.text))) continue;
          boxes++;
          const current = sourceParagraphLineHeight(block);
          const seeded = sourceParagraphs(block), previous = previousLineHeight(block);
          const oldLayouts = seeded.lines.map((group, index) => {
            const upper = seeded.lines[index - 1]?.at(-1);
            const gap = upper ? upper.baselineY - group[0]!.baselineY - previous : 0;
            return { ...seeded.layouts[index]!, gapBeforePt: gap > 0.5 ? gap : 0 };
          });
          if (current === previous) {
            unchanged++;
            expect(seeded.layouts, `${file} p${pageIndex + 1}: unchanged layout`).toEqual(oldLayouts);
          } else {
            expect(file).toMatch(/corporate-edited-3|Corporate-Governance-edited/);
            changes.push({ file, page: pageIndex + 1, text: block.text, previousPt: previous, currentPt: current,
              layouts: seeded.layouts, paragraphRows: seeded.lines.map(group => group.length) });
          }
          const inside = seeded.lines.flatMap((group) => group.slice(1).map((line, index) => group[index]!.baselineY - line.baselineY)).filter((gap) => gap > 0.5);
          if (inside.length < 2) continue;
          const bins = new Map<number, number[]>();
          for (const gap of inside) { const key = Math.round(gap * 2); bins.set(key, [...(bins.get(key) ?? []), gap]); }
          const mode = [...bins.values()].sort((a, b) => b.length - a.length)[0]!;
          const insideSpacing = mode.reduce((sum, gap) => sum + gap, 0) / mode.length;
          if (Math.abs(current - insideSpacing) > 0.5) {
            changed++;
            const wrapped = inside.length;
            extraHeight += (current - insideSpacing) * wrapped;
            const name = file.replace(/.*\//, '');
            byFile[name] ??= { changed: 0, example: `p${pageIndex + 1}: editor ${current.toFixed(1)} pt vs inside ${insideSpacing.toFixed(1)} pt | ${block.text.replace(/\s+/g, ' ').slice(0, 50)}` };
            byFile[name]!.changed++;
          }
        }
      }
      } finally { await document.destroy(); }
    }
    process.stdout.write(`\nSPACING ${changed} of ${boxes} multi-line boxes open with the wrong line spacing; files ${Object.keys(byFile).length}; average height error ${(extraHeight / Math.max(1, changed)).toFixed(1)} pt per box\n`);
    for (const [file, value] of Object.entries(byFile).sort((a, b) => b[1].changed - a[1].changed)) process.stdout.write(`  ${file}: ${value.changed} | ${value.example}\n`);
    await mkdir('tmp/task80', { recursive: true });
    await writeFile('tmp/task80/fix-a-scope.json', JSON.stringify({ files: files.length, pages, boxes, wrong: changed, unchanged, changes }, null, 2));
    expect(files).toHaveLength(47);
    expect(boxes).toBe(1466); expect(changed).toBe(0); expect(changes).toHaveLength(20); expect(unchanged).toBe(1446);
  });
});
