import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns, groupRunsIntoBlocks } from './textContent';
import { detectRuleLines } from './ruleLines';
import { detectPageGraphicRegions } from './shapeMarkers';
import { attachedOrdinals } from './attachedOrdinals';

const fixtures = [['tmp/text-doubling/ziro.pdf', 1], ['tmp/compress-tests/healing.pdf', 1],
  ['tmp/compress-tests/healing.pdf', 17], ['tmp/compress-tests/ladakh-original.pdf', 1]] as const;

describe.runIf(process.env.TASK84_REAL === '1')('Task 84 real ordinals', () => {
  it('records the original date and shadow geometry', async () => {
    const rows = [];
    for (const [file, pageNumber] of fixtures) {
      const doc = await getDocument({ data: new Uint8Array(await readFile(file)), fontExtraProperties: true, verbosity: 0 }).promise;
      try {
        const page = await doc.getPage(pageNumber), index = pageNumber - 1;
        const runs = await extractTextRuns(page, index);
        const [ruleLines, regions] = await Promise.all([detectRuleLines(page, index), detectPageGraphicRegions(page, index)]);
        const blocks = groupRunsIntoBlocks(runs, { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] });
        const small = runs.filter(run => /^(st|nd|rd|th)$/iu.test(run.text.trim()));
        expect(small.length).toBeGreaterThan(0);
        const plans = attachedOrdinals(blocks, runs);
        expect(plans.flatMap(plan => plan.ordinals)).toHaveLength(2);
        process.stdout.write(JSON.stringify({ file, page: pageNumber, plans: plans.map(plan => ({ text: plan.editor.text,
          ordinals: plan.ordinals.map(value => ({ number: value.number, text: value.text, copies: value.copies.length })), members: plan.members.length })) }) + '\n');
        rows.push({ file, page: pageNumber, runs: runs.filter(run => small.some(ordinal => Math.abs(run.rect.y - ordinal.rect.y) < ordinal.style.fontSizePt * 2)),
          blocks: blocks.filter(block => small.some(ordinal => Math.abs(block.rect.y - ordinal.rect.y) < ordinal.style.fontSizePt * 2)) });
      } finally { await doc.destroy(); }
    }
    await mkdir('tmp/task84', { recursive: true });
    await writeFile('tmp/task84/inspect.json', JSON.stringify(rows, null, 2));
  }, 120_000);
});
