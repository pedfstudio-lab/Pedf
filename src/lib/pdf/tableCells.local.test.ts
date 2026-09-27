import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  detectRuleLines,
  ruleLinesFromOperatorList,
  type RuleLine,
} from './ruleLines';
import {
  extractTextRuns,
  groupRunsIntoBlocks,
  mergeRunsIntoLines,
  type TextBlock,
  type TextLine,
  type TextRun,
} from './textContent';

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
  cellSplits: string[];
  rowSplits: string[];
  localItemSplits: string[];
  stretchedJoins: string[];
  paragraphSplits: string[];
  paragraphJoins: string[];
  alignmentChanges: string[];
  unexplained: string[];
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

function ruleKey(line: RuleLine): string {
  return [
    line.orientation,
    line.x1.toFixed(3),
    line.y1.toFixed(3),
    line.x2.toFixed(3),
    line.y2.toFixed(3),
    line.thicknessPt.toFixed(3),
  ].join(':');
}

function separatedRunPairs(before: readonly TextLine[], after: readonly TextLine[]): string[] {
  const owners = new Map<TextRun, number>();
  after.forEach((line, lineIndex) => {
    line.runs.forEach((run) => owners.set(run, lineIndex));
  });
  return before.flatMap((line) => line.runs.slice(1).flatMap((right, index) => {
    const left = line.runs[index];
    if (!left || owners.get(left) === owners.get(right)) return [];
    return [`${preview(left.text)} | ${preview(right.text)}`];
  }));
}

function separatedLinePairs(before: readonly TextBlock[], after: readonly TextBlock[]): string[] {
  const owners = new Map<TextRun, number>();
  after.forEach((block, blockIndex) => {
    block.lines.forEach((line) => line.runs.forEach((run) => owners.set(run, blockIndex)));
  });
  return before.flatMap((block) => block.lines.slice(1).flatMap((lower, index) => {
    const upper = block.lines[index];
    const upperRun = upper?.runs[0];
    const lowerRun = lower.runs[0];
    if (!upperRun || !lowerRun || owners.get(upperRun) === owners.get(lowerRun)) return [];
    return [`${preview(upper.text)} | ${preview(lower.text)}`];
  }));
}

function separatedBlockRunPairs(before: readonly TextBlock[], after: readonly TextBlock[]): string[] {
  const owners = new Map<TextRun, number>();
  after.forEach((block, blockIndex) => {
    block.lines.forEach((line) => line.runs.forEach((run) => owners.set(run, blockIndex)));
  });
  return before.flatMap((block) => {
    const runs = block.lines.flatMap((line) => line.runs);
    return runs.slice(1).flatMap((right, index) => {
      const left = runs[index];
      if (!left || owners.get(left) === owners.get(right)) return [];
      return [`${preview(left.text)} | ${preview(right.text)}`];
    });
  });
}

function blockRunKey(block: TextBlock, runIndexes: ReadonlyMap<TextRun, number>): string {
  return block.lines
    .flatMap((line) => line.runs)
    .map((run) => runIndexes.get(run) ?? -1)
    .sort((left, right) => left - right)
    .join(',');
}

function alignmentChanges(
  before: readonly TextBlock[],
  after: readonly TextBlock[],
  runs: readonly TextRun[],
): string[] {
  const runIndexes = new Map(runs.map((run, index) => [run, index]));
  const beforeByRuns = new Map(before.map((block) => [blockRunKey(block, runIndexes), block]));
  return after.flatMap((block) => {
    const previous = beforeByRuns.get(blockRunKey(block, runIndexes));
    if (!previous || previous.align === block.align) return [];
    return [`${previous.align ?? 'left'} -> ${block.align ?? 'left'}: ${preview(block.text)}`];
  });
}

afterEach(async () => {
  await Promise.all(openDocuments.splice(0).map((document) => document.destroy()));
});

describe.skipIf(!enabled)('Task 70 local table-cell sweep', () => {
  it('preserves unswitched grouping and creates only rule-aware editor boxes', async () => {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Baseline;
    expect(baseline.version).toBe(1);
    const comparisons: Comparison[] = [];
    let rejectedUnderlineCandidates = 0;

    for (const [file, expected] of Object.entries(baseline.files).sort(([left], [right]) => left.localeCompare(right))) {
      const bytes = new Uint8Array(await readFile(file));
      const document = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
      openDocuments.push(document);
      expect(document.numPages, `${file}: page count`).toBe(expected.pages.length);
      const before: string[] = [];
      const after: string[] = [];
      const beforeLines: string[] = [];
      const afterLines: string[] = [];
      const cellSplits: string[] = [];
      const rowSplits: string[] = [];
      const localItemSplits: string[] = [];
      const stretchedJoins: string[] = [];
      const paragraphSplits: string[] = [];
      const paragraphJoins: string[] = [];
      const changedAlignments: string[] = [];
      const unexplained: string[] = [];

      for (const expectedPage of expected.pages) {
        const page = await document.getPage(expectedPage.pageIndex + 1);
        const [runs, ruleLines, operatorList] = await Promise.all([
          extractTextRuns(page, expectedPage.pageIndex),
          detectRuleLines(page, expectedPage.pageIndex),
          page.getOperatorList(),
        ]);
        const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = page.view;
        const unguardedLines = ruleLinesFromOperatorList(
          operatorList,
          expectedPage.pageIndex,
          { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
        );
        const guardedKeys = new Set(ruleLines.map(ruleKey));
        rejectedUnderlineCandidates += unguardedLines.filter((line) => (
          line.orientation === 'horizontal' && !guardedKeys.has(ruleKey(line))
        )).length;
        const legacyLines = mergeRunsIntoLines(runs);
        const legacyBlocks = groupRunsIntoBlocks(runs);
        const unchangedLines = legacyLines.map((line) => line.text);
        const unchangedBlocks = legacyBlocks.map((block) => block.text);
        expect(unchangedLines, `${file} page ${expectedPage.pageIndex + 1}: unswitched lines`)
          .toEqual(expectedPage.lines);
        expect(unchangedBlocks, `${file} page ${expectedPage.pageIndex + 1}: unswitched blocks`)
          .toEqual(expectedPage.blocks);

        const verticalRules = ruleLines.filter((line) => line.orientation === 'vertical');
        const localLines = mergeRunsIntoLines(runs, { ruleLines: [] });
        const editorLines = mergeRunsIntoLines(runs, { ruleLines: verticalRules });
        const localBlocks = groupRunsIntoBlocks(runs, { ruleLines: [] });
        const verticalOnlyBlocks = groupRunsIntoBlocks(runs, { ruleLines: verticalRules });
        const editorBlocks = groupRunsIntoBlocks(runs, { ruleLines });
        const pageLocalItemSplits = separatedRunPairs(legacyLines, localLines);
        const pageStretchedJoins = separatedRunPairs(localLines, legacyLines);
        const pageCellSplits = separatedRunPairs(localLines, editorLines);
        const unexpectedCellJoins = separatedRunPairs(editorLines, localLines);
        const pageParagraphSplits = separatedBlockRunPairs(legacyBlocks, localBlocks);
        const pageParagraphJoins = separatedBlockRunPairs(localBlocks, legacyBlocks);
        const pageRowSplits = separatedLinePairs(verticalOnlyBlocks, editorBlocks);
        const unexpectedRowJoins = separatedLinePairs(editorBlocks, verticalOnlyBlocks);
        const pageAlignmentChanges = alignmentChanges(legacyBlocks, editorBlocks, runs);
        localItemSplits.push(...pageLocalItemSplits.map((value) => `page ${expectedPage.pageIndex + 1}: ${value}`));
        stretchedJoins.push(...pageStretchedJoins.map((value) => `page ${expectedPage.pageIndex + 1}: ${value}`));
        cellSplits.push(...pageCellSplits.map((value) => `page ${expectedPage.pageIndex + 1}: ${value}`));
        paragraphSplits.push(...pageParagraphSplits.map((value) => `page ${expectedPage.pageIndex + 1}: ${value}`));
        paragraphJoins.push(...pageParagraphJoins.map((value) => `page ${expectedPage.pageIndex + 1}: ${value}`));
        rowSplits.push(...pageRowSplits.map((value) => `page ${expectedPage.pageIndex + 1}: ${value}`));
        changedAlignments.push(...pageAlignmentChanges.map((value) => `page ${expectedPage.pageIndex + 1}: ${value}`));
        const cellDelta = editorLines.length - localLines.length;
        const rowDelta = editorBlocks.length - verticalOnlyBlocks.length;
        if (cellDelta !== pageCellSplits.length) {
          unexplained.push(
            `page ${expectedPage.pageIndex + 1}: line delta ${cellDelta}, classified ${pageCellSplits.length}`,
          );
        }
        if (rowDelta !== pageRowSplits.length) {
          unexplained.push(
            `page ${expectedPage.pageIndex + 1}: block delta ${rowDelta}, classified ${pageRowSplits.length}`,
          );
        }
        if (unexpectedCellJoins.length > 0) {
          unexplained.push(
            `page ${expectedPage.pageIndex + 1}: vertical borders joined ${unexpectedCellJoins.length} boundaries`,
          );
        }
        if (unexpectedRowJoins.length > 0) {
          unexplained.push(
            `page ${expectedPage.pageIndex + 1}: horizontal borders joined ${unexpectedRowJoins.length} boundaries`,
          );
        }
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
        cellSplits,
        rowSplits,
        localItemSplits,
        stretchedJoins,
        paragraphSplits,
        paragraphJoins,
        alignmentChanges: changedAlignments,
        unexplained,
      };
      const classified = comparison.cellSplits.length
        + comparison.rowSplits.length
        + comparison.localItemSplits.length
        + comparison.stretchedJoins.length
        + comparison.paragraphSplits.length
        + comparison.paragraphJoins.length
        + comparison.alignmentChanges.length;
      if ((comparison.removed.length > 0 || comparison.added.length > 0) && classified === 0) {
        comparison.unexplained.push('changed boxes without a classified boundary or alignment change');
      }
      comparisons.push(comparison);
      process.stdout.write(
        `${file} | boxes ${comparison.before} -> ${comparison.after}`
        + ` | changed ${comparison.removed.length} old / ${comparison.added.length} new\n`,
      );
      for (const value of comparison.removed) process.stdout.write(`  OLD ${preview(value)}\n`);
      for (const value of comparison.added) process.stdout.write(`  NEW ${preview(value)}\n`);
      for (const value of comparison.cellSplits) process.stdout.write(`  (a) CELL ${value}\n`);
      for (const value of comparison.rowSplits) process.stdout.write(`  (b) ROW ${value}\n`);
      for (const value of comparison.localItemSplits) process.stdout.write(`  (c) ITEM ${value}\n`);
      for (const value of comparison.stretchedJoins) process.stdout.write(`  (d) STRETCHED ${value}\n`);
      for (const value of comparison.paragraphSplits) process.stdout.write(`  (e) PARAGRAPH SPLIT ${value}\n`);
      for (const value of comparison.paragraphJoins) process.stdout.write(`  (f) PARAGRAPH JOIN ${value}\n`);
      for (const value of comparison.alignmentChanges) process.stdout.write(`  (g) ALIGN ${value}\n`);
      for (const value of comparison.unexplained) process.stdout.write(`  (?) UNEXPLAINED ${value}\n`);
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
    expect(sriLanka?.added.some((value) => value.startsWith('Nuwara Eliya – Ella'))).toBe(true);
    expect(sriLanka?.added.some((value) => value.startsWith('Bentota – Colombo'))).toBe(true);
    expect(sriLanka?.added.some((value) => value.startsWith('Colombo – Airport'))).toBe(true);

    const noTable = comparisons.find((result) => result.file === 'tmp/sign-tests/crop-offset.pdf');
    expect(noTable, 'known no-table fixture').toBeDefined();
    expect(noTable?.removed).toEqual([]);
    expect(noTable?.added).toEqual([]);

    const cellSplitTotal = comparisons.reduce((sum, result) => sum + result.cellSplits.length, 0);
    const rowSplitTotal = comparisons.reduce((sum, result) => sum + result.rowSplits.length, 0);
    const localItemSplitTotal = comparisons.reduce((sum, result) => sum + result.localItemSplits.length, 0);
    const stretchedJoinTotal = comparisons.reduce((sum, result) => sum + result.stretchedJoins.length, 0);
    const paragraphSplitTotal = comparisons.reduce((sum, result) => sum + result.paragraphSplits.length, 0);
    const paragraphJoinTotal = comparisons.reduce((sum, result) => sum + result.paragraphJoins.length, 0);
    const alignmentChangeTotal = comparisons.reduce((sum, result) => sum + result.alignmentChanges.length, 0);
    const unexplained = comparisons.flatMap((result) => result.unexplained);
    expect(cellSplitTotal).toBe(14);
    expect(rowSplitTotal).toBe(40);
    expect(unexplained).toEqual([]);
    expect(rejectedUnderlineCandidates).toBe(32);

    process.stdout.write(
      `TASK70 TOTAL files ${comparisons.length}, changed ${comparisons.filter((result) => result.removed.length > 0).length}\n`,
    );
    process.stdout.write(
      `TASK74 BORDER SPLITS cells ${cellSplitTotal} / predicted 13`
      + ` | rows ${rowSplitTotal} / predicted 33`
      + ` | unexplained ${unexplained.length}`
      + ` | horizontal underline candidates rejected ${rejectedUnderlineCandidates}\n`,
    );
    process.stdout.write(
      `TASK74 STEP 2 local item splits ${localItemSplitTotal}`
      + ` | stretched joins ${stretchedJoinTotal}`
      + ` | paragraph splits ${paragraphSplitTotal}`
      + ` | paragraph joins ${paragraphJoinTotal}`
      + ` | alignment changes ${alignmentChangeTotal}`
      + ` | unexplained ${unexplained.length}\n`,
    );
    process.stdout.write(
      'TASK74 VARIANCE the survey counted affected merged units; this test counts every separated boundary'
      + ' in every duplicate PDF. Cells +1: Ziro 6, Sri Lanka 3, Corporate Governance 5;'
      + ' rows +7: Rishi copies 24, CV copies 12, Rahul copies 4.\n',
    );
  }, 600_000);
});
