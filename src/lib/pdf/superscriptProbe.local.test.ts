import { readFile } from 'node:fs/promises';
import { describe, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { extractTextRuns, groupRunsIntoBlocks } from './textContent';
import { detectPageGraphicRegions } from './shapeMarkers';
import { detectRuleLines } from './ruleLines';

// Probe for the user's report: superscript ordinals ("rd", "th") are separate boxes.
describe.runIf(process.env.SUPERSCRIPT_PROBE === '1')('superscript ordinals', () => {
  it('lists the runs and boxes around dates', { timeout: 120_000 }, async () => {
    for (const [path, pageNumber] of [['tmp/text-doubling/ziro.pdf', 1], ['tmp/compress-tests/healing.pdf', 1],
      ['tmp/compress-tests/ladakh-original.pdf', 1], ['tmp/compress-tests/healing.pdf', 17]] as const) {
      const doc = await getDocument({ data: new Uint8Array(await readFile(path)), verbosity: 0 }).promise as unknown as PDFDocumentProxy;
      const page = await doc.getPage(pageNumber);
      const runs = await extractTextRuns(page, pageNumber - 1);
      const [ruleLines, regions] = await Promise.all([detectRuleLines(page, pageNumber - 1), detectPageGraphicRegions(page, pageNumber - 1)]);
      const blocks = groupRunsIntoBlocks(runs, { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] });
      const tiny = runs.filter(run => /^(st|nd|rd|th)$/i.test(run.text.trim()));
      console.log(`\n== ${path} p${pageNumber}`);
      for (const sup of tiny) {
        const owner = blocks.find(block => block.lines.some(line => line.runs.includes(sup)));
        const before = runs.filter(run => run !== sup && Math.abs(run.rect.x + run.rect.w - sup.rect.x) < sup.style.fontSizePt * 1.5
          && run.rect.y < sup.rect.y + sup.rect.h && run.rect.y + run.rect.h > sup.rect.y);
        console.log(`"${sup.text}" ${sup.style.fontSizePt.toFixed(1)}pt x=${sup.rect.x.toFixed(1)} y=${sup.rect.y.toFixed(1)}`
          + ` | own box: ${JSON.stringify(owner?.text)} (${owner?.lines.length} lines)`
          + ` | text just left: ${before.map(run => `${JSON.stringify(run.text)} ${run.style.fontSizePt.toFixed(1)}pt y=${run.rect.y.toFixed(1)}`).join(', ')}`);
      }
      await doc.destroy();
    }
  });
});
