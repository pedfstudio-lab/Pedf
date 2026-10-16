import { readFile } from 'node:fs/promises';
import { describe, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns } from '@/lib/pdf/textContent';
import { sourceFontWidth } from '@/lib/fonts/fontMatch';

// Probe: does a page draw its text tighter than the font's own letter widths (tracking)?
// Compares, run by run, the width the PDF actually draws with the sum of the font's
// nominal letter widths (what Task 78's width matching is calibrated on).
describe.runIf(process.env.TRACKING_PROBE === '1')('tracking probe', () => {
  it('Healing p3 and Ladakh p2', { timeout: 120_000 }, async () => {
    for (const [file, pageIndex] of [['tmp/compress-tests/healing.pdf', 2], ['tmp/compress-tests/ladakh-original.pdf', 1]] as const) {
      const document = await getDocument({ data: new Uint8Array(await readFile(file)), verbosity: 0, fontExtraProperties: true }).promise;
      const runs = await extractTextRuns(await document.getPage(pageIndex + 1), pageIndex);
      let drawn = 0, nominal = 0, counted = 0;
      for (const run of runs) {
        const text = run.text.replace(/\s+$/u, '');
        if ([...text].length < 4) continue;
        const own = sourceFontWidth(text, run.style);
        if (own === undefined || !run.metrics) continue;
        drawn += run.metrics.widthPt; nominal += own; counted++;
      }
      process.stdout.write(`\nTRACKING ${file} p${pageIndex + 1}: ${counted} runs; drawn ${drawn.toFixed(1)} pt vs the font's own letters ${nominal.toFixed(1)} pt → drawn is ${((drawn / nominal - 1) * 100).toFixed(1)} %\n`);
      await document.destroy();
    }
  });
});
