import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { detectRuleLines } from './ruleLines';
import { extractTextRuns, groupRunsIntoBlocks, mergeRunsIntoLines } from './textContent';

const baselinePath = 'tmp/tables/baseline.json';
const enabled = process.env.TASK70_TABLES === '1' && existsSync(baselinePath);
if (!enabled) {
  process.stdout.write(
    'Task 70 local table-cell sweep skipped: set TASK70_TABLES=1 with tmp/tables/baseline.json present.\n',
  );
}

interface BaselinePage {
  pageIndex: number;
  lines: string[];
  blocks: string[];
}

interface BaselineFile {
  pages: BaselinePage[];
}

interface Baseline {
  version: number;
  files: Record<string, BaselineFile>;
  unreadable: string[];
}

interface Comparison {
  file: string;
  before: number;
  after: number;
  removed: string[];
  added: string[];
  removedLines: string[];
  addedLines: string[];
}

const openDocuments: PDFDocumentProxy[] = [];

function difference(left: readonly string[], right: readonly string[]): string[] {
  const available = new Map<string, number>();
  for (const value of right) available.set(value, (available.get(value) ?? 0) + 1);
  return left.filter((value) => {
    const count = available.get(value) ?? 0;
    if (count === 0) return true;
    available.set(value, count - 1);
    return false;
  });
}

function preview(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, ' ').slice(0, 60));
}

afterEach(async () => {
  await Promise.all(openDocuments.splice(0).map((document) => document.destroy()));
});

describe.skipIf(!enabled)('Task 70 local table-cell sweep', () => {
  it('preserves unswitched grouping and creates only rule-aware editor boxes', async () => {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Baseline;
    expect(baseline.version).toBe(1);
    const comparisons: Comparison[] = [];

    for (const [file, expected] of Object.entries(baseline.files).sort(([left], [right]) => left.localeCompare(right))) {
      const bytes = new Uint8Array(await readFile(file));
      const document = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
      openDocuments.push(document);
      expect(document.numPages, `${file}: page count`).toBe(expected.pages.length);
      const before: string[] = [];
      const after: string[] = [];
      const beforeLines: string[] = [];
      const afterLines: string[] = [];

      for (const expectedPage of expected.pages) {
        const page = await document.getPage(expectedPage.pageIndex + 1);
        const [runs, ruleLines] = await Promise.all([
          extractTextRuns(page, expectedPage.pageIndex),
          detectRuleLines(page, expectedPage.pageIndex),
        ]);
        const unchangedLines = mergeRunsIntoLines(runs).map((line) => line.text);
        const unchangedBlocks = groupRunsIntoBlocks(runs).map((block) => block.text);
        expect(unchangedLines, `${file} page ${expectedPage.pageIndex + 1}: unswitched lines`)
          .toEqual(expectedPage.lines);
        expect(unchangedBlocks, `${file} page ${expectedPage.pageIndex + 1}: unswitched blocks`)
          .toEqual(expectedPage.blocks);

        const editorBlocks = groupRunsIntoBlocks(runs, { ruleLines });
        const editorLines = mergeRunsIntoLines(runs, { ruleLines });
        before.push(...expectedPage.blocks);
        after.push(...editorBlocks.map((block) => block.text));
        beforeLines.push(...expectedPage.lines);
        afterLines.push(...editorLines.map((line) => line.text));

        if (file === 'tmp/tables/Fraction Chart.pdf') {
          const percentageRuns = runs.filter((run) => run.text.includes('%'));
          for (const run of percentageRuns) {
            const owners = editorBlocks.filter((block) => (
              block.lines.some((line) => line.runs.some((candidate) => candidate === run))
            ));
            expect(owners, `percentage cell ${JSON.stringify(run.text)}`).toHaveLength(1);
            const owner = owners[0];
            expect(owner?.text).toBe(run.text.trim());
            expect(owner?.lines.flatMap((line) => line.runs)).toEqual([run]);
          }
          for (const block of editorBlocks) {
            expect(block.text.match(/%/g)?.length ?? 0).toBeLessThanOrEqual(1);
          }
        }
      }

      const comparison: Comparison = {
        file,
        before: before.length,
        after: after.length,
        removed: difference(before, after),
        added: difference(after, before),
        removedLines: difference(beforeLines, afterLines),
        addedLines: difference(afterLines, beforeLines),
      };
      comparisons.push(comparison);
      process.stdout.write(
        `${file} | boxes ${comparison.before} -> ${comparison.after}`
        + ` | changed ${comparison.removed.length} old / ${comparison.added.length} new\n`,
      );
      for (const value of comparison.removed) process.stdout.write(`  OLD ${preview(value)}\n`);
      for (const value of comparison.added) process.stdout.write(`  NEW ${preview(value)}\n`);
      await document.destroy();
      openDocuments.splice(openDocuments.indexOf(document), 1);
    }

    const fraction = comparisons.find((result) => result.file === 'tmp/tables/Fraction Chart.pdf');
    expect(fraction).toBeDefined();
    expect(fraction?.before).toBe(66);
    expect(fraction?.after).toBe(218);
    expect((fraction?.after ?? 0) - (fraction?.before ?? 0)).toBe(152);
    expect(fraction?.removed).toHaveLength(19);
    expect(fraction?.added).toHaveLength(171);

    const sriLanka = comparisons.find(
      (result) => result.file === 'tmp/tables/Firgun_QT-H4SNASRX_SriLanka.pdf',
    );
    expect(sriLanka).toBeDefined();
    expect(sriLanka?.removedLines).toHaveLength(3);
    expect(sriLanka?.addedLines).toHaveLength(6);
    expect(sriLanka?.removedLines.map((value) => (
      value.startsWith('Nuwara Eliya – Ella After breakfast')
      || value.startsWith('Bentota – Colombo After breakfast')
      || value.startsWith('Colombo – Airport One last Sri Lankan breakfast')
    ))).toEqual([true, true, true]);
    // Day 3's newly separated description correctly rejoins its existing wrapped continuation.
    // That replaces one extra baseline block even though only the three route/description rows split.
    expect(sriLanka?.removed).toHaveLength(4);
    expect(sriLanka?.added).toHaveLength(7);
    expect(sriLanka?.added.some((value) => value.startsWith('Nuwara Eliya – Ella'))).toBe(true);
    expect(sriLanka?.added.some((value) => value.startsWith('Bentota – Colombo'))).toBe(true);
    expect(sriLanka?.added.some((value) => value.startsWith('Colombo – Airport'))).toBe(true);

    const noTable = comparisons.find((result) => result.file === 'tmp/sign-tests/crop-offset.pdf');
    expect(noTable, 'known no-table fixture').toBeDefined();
    expect(noTable?.removed).toEqual([]);
    expect(noTable?.added).toEqual([]);

    process.stdout.write(
      `TASK70 TOTAL files ${comparisons.length}, changed ${comparisons.filter((result) => result.removed.length > 0).length}\n`,
    );
  }, 600_000);
});
