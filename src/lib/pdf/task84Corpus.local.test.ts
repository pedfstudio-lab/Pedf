import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { attachedOrdinals } from './attachedOrdinals';
import { extractTextRuns, groupRunsIntoBlocks } from './textContent';
import { detectRuleLines } from './ruleLines';
import { detectPageGraphicRegions } from './shapeMarkers';

describe.runIf(process.env.TASK84_CORPUS === '1')('Task 84 ordinal corpus inventory', () => {
  it('publishes every attachment in the 47 PDFs and checks the independent source evidence', async () => {
    const frozen = JSON.parse(await readFile('tmp/5d/source-text-before.json', 'utf8')) as Record<string, unknown>;
    const files = [...Object.keys(frozen), "tmp/paragraphs/Bhutan December'26.pdf", 'tmp/paragraphs/Corporate-Governance-edited (25).pdf'];
    expect(files).toHaveLength(47);
    const attachments: Record<string, unknown>[] = [], summary: Record<string, unknown>[] = [];
    await mkdir('tmp/task84', { recursive: true });
    let pages = 0;
    for (const [index, file] of files.entries()) {
      const reader = await getDocument({ data: new Uint8Array(await readFile(file)), fontExtraProperties: true, verbosity: 0 }).promise;
      const beforeCount = attachments.length;
      try {
        for (let pageNumber = 1; pageNumber <= reader.numPages; pageNumber++) {
          const page = await reader.getPage(pageNumber), pageIndex = pageNumber - 1;
          const runs = await extractTextRuns(page, pageIndex); pages++;
          if (!runs.some(run => /^(st|nd|rd|th)$/iu.test(run.text.trim()))) continue;
          const [ruleLines, regions] = await Promise.all([detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex)]);
          const blocks = groupRunsIntoBlocks(runs, { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] });
          const original = JSON.stringify(blocks);
          const plans = attachedOrdinals(blocks, runs);
          expect(JSON.stringify(blocks), 'grouping and original model not modified').toBe(original);
          for (const plan of plans) for (const ordinal of plan.ordinals) {
            const size = ordinal.body.style.fontSizePt;
            const rise = (ordinal.run.metrics?.baselineY ?? ordinal.run.rect.y) - (ordinal.body.metrics?.baselineY ?? ordinal.body.rect.y);
            const gap = ordinal.run.rect.x - ordinal.body.rect.x - ordinal.body.rect.w;
            expect(ordinal.text).toMatch(/^(st|nd|rd|th)$/iu);
            expect(ordinal.body.text.trimEnd()).toMatch(new RegExp(`(?:^|[^\\p{L}\\p{N}])${ordinal.number}$`, 'u'));
            expect(ordinal.run.style.fontSizePt / size).toBeLessThanOrEqual(0.8);
            expect(rise).toBeGreaterThanOrEqual(Math.max(1.5, size * 0.1));
            expect(rise).toBeLessThanOrEqual(size * 0.8);
            expect(gap).toBeGreaterThanOrEqual(-Math.max(2, size * 0.12));
            expect(gap).toBeLessThanOrEqual(Math.max(1, size * 0.3));
            attachments.push({ file, page: pageNumber, number: ordinal.number, ordinal: ordinal.text, copies: ordinal.copies.length,
              sizePt: ordinal.run.style.fontSizePt, bodySizePt: size, risePt: rise, gapPt: gap, context: plan.editor.text });
          }
        }
        summary.push({ file, pages: reader.numPages, attachments: attachments.length - beforeCount });
      } finally { await reader.destroy(); }
      await writeFile('tmp/task84/attachments.json', JSON.stringify({ files: files.length, pages, summary, attachments }, null, 2));
      process.stdout.write(`Task84 ordinal survey ${index + 1}/47: ${attachments.length - beforeCount} attachments | ${file}\n`);
    }
    const escape = (value: unknown) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' / ');
    const report = ['# Task 84 attachment inventory', '', `${files.length} PDFs; ${pages} pages; ${attachments.length} logical ordinals.`, '',
      'All entries satisfy exact suffix, numeric left neighbour, smaller size, raised baseline and close horizontal gap. Source grouping is unchanged.', '',
      '| File | Page | Number + suffix | Physical copies | Size / body (pt) | Rise / gap (pt) | Context |',
      '|---|---:|---|---:|---|---|---|', ...attachments.map(row => `| ${escape(row.file)} | ${row.page} | ${row.number}${row.ordinal} | ${row.copies} | ${Number(row.sizePt).toFixed(2)} / ${Number(row.bodySizePt).toFixed(2)} | ${Number(row.risePt).toFixed(2)} / ${Number(row.gapPt).toFixed(2)} | ${escape(row.context)} |`), ''];
    await writeFile('tmp/task84/ATTACHMENT_REVIEW.md', report.join('\n'));
    expect(attachments.length).toBeGreaterThan(0);
  }, 1_200_000);
});
