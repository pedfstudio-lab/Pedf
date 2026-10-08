import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns, groupRunsIntoBlocks } from './textContent';
import { detectRuleLines } from './ruleLines';
import { detectPageGraphicRegions } from './shapeMarkers';
import { startsWithBulletMarker, lineHasDrawnMarker } from './textUnits';
import { pageLinePitches, biggerParagraphGap } from './paragraphPitch';

describe.runIf(process.env.TASK74_PITCH === '1')('Change 10 Part B measurement before activation', () => {
  it('names every proposed gap split', { timeout: 600_000 }, async () => {
    const baseline = JSON.parse(await readFile('tmp/tables/baseline.json', 'utf8')) as { files: Record<string, { pages: { pageIndex: number }[] }> };
    const files = [...Object.keys(baseline.files), 'tmp/ziro-check.pdf'].filter((file, index, array) => existsSync(file) && array.indexOf(file) === index);
    const splits: { file: string; page: number; upper: string; lower: string; gap: number; pitch: number }[] = [];
    for (const file of files) {
      const document = await getDocument({ data: new Uint8Array(await readFile(file)), verbosity: 0, fontExtraProperties: true }).promise;
      try {
        for (const pageIndex of baseline.files[file]?.pages.map(page => page.pageIndex) ?? Array.from({ length: document.numPages }, (_, i) => i)) {
          const page = await document.getPage(pageIndex + 1);
          const [runs, ruleLines, regions] = await Promise.all([extractTextRuns(page, pageIndex), detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex)]);
          const markers = [...regions.imageRegions, ...regions.shapeMarkerRegions];
          const blocks = groupRunsIntoBlocks(runs, { ruleLines, markers, preserveParagraphGaps: true }), pitches = pageLinePitches(blocks.flatMap(block => block.lines));
          for (const block of blocks) {
            if (block.lines.some(line => startsWithBulletMarker(line.text) || lineHasDrawnMarker(line, markers))) continue;
            block.lines.slice(1).forEach((lower, index) => {
              const upper = block.lines[index]!;
              if (biggerParagraphGap(upper, lower, pitches)) splits.push({ file, page: pageIndex + 1, upper: upper.text, lower: lower.text,
                gap: upper.baselineY - lower.baselineY, pitch: Math.max(pitches.get(upper) ?? 0, pitches.get(lower) ?? 0) });
            });
          }
        }
      } finally { await document.destroy(); }
    }
    await writeFile('tmp/pdfs/change10-pitch-measure.json', JSON.stringify({ files: files.length, count: splits.length, splits }, null, 2));
    process.stdout.write(JSON.stringify({ files: files.length, count: splits.length }) + '\n' + splits.map(split => `${split.file} p${split.page}: ${split.gap.toFixed(2)} > 1.3 × ${split.pitch.toFixed(2)} | ${split.upper} / ${split.lower}`).join('\n'));
    expect(splits.some(split => split.file.includes('corporate-edited-3') && split.page === 11 && split.lower.startsWith('(i) Transparency'))).toBe(true);
  });
});
