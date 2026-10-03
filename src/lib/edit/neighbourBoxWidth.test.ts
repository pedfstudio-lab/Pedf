import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { TextBlock } from '@/lib/pdf/textContent';
import { neighbourBoxWidth } from './neighbourBoxWidth';

const reachBaselinePath = 'tmp/tables/baseline.json';
const reachEnabled = process.env.TASK74_REAL === '1' && existsSync(reachBaselinePath);

interface ReachBaseline {
  files: Record<string, { pages: { pageIndex: number }[] }>;
}

const block: TextBlock = {
  pageIndex: 0, text: 'email', rect: { x: 234.7, y: 100, w: 297.5, h: 12 },
  topBaselineY: 100, lineHeightPt: 14, lines: [],
  style: { fontName: 'Helvetica', fontSizePt: 12, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } },
  align: 'right', alignLeftPt: 68.2, alignWidthPt: 467.7,
};
const phone = { ...block, text: 'phone', rect: { x: 77.3, y: 100, w: 59.7, h: 12 } };

function geometry(value: TextBlock = block) {
  return {
    pageIndex: value.pageIndex,
    rect: value.rect,
    align: value.align ?? 'left',
    alignLeftPt: value.alignLeftPt ?? value.rect.x,
    alignWidthPt: value.alignWidthPt ?? value.rect.w,
  };
}

describe('neighbourBoxWidth', () => {
  it('stops at the closest neighbour on either side without changing alignment metadata', () => {
    const before = JSON.stringify(block);
    const right = { ...phone, rect: { ...phone.rect, x: 534 } };
    const result = neighbourBoxWidth(geometry(), [phone, right]);
    expect(result.left).toBeCloseTo(137);
    expect(result.left + result.width).toBeCloseTo(534);
    expect(JSON.stringify(block)).toBe(before);
    expect(neighbourBoxWidth(geometry(), [phone]).width).toBeCloseTo(398.9);
  });

  it('keeps the region when there is no neighbour on the same row and page', () => {
    const otherPage = { ...phone, pageIndex: 1 };
    const halfOverlap = { ...phone, rect: { ...phone.rect, y: 106 } };
    expect(neighbourBoxWidth(geometry(), [otherPage, halfOverlap]))
      .toEqual({ left: 68.2, width: 467.7 });
  });

  it('never cuts into the source block, even with overlapping neighbours or a narrow region', () => {
    const overlapping = { ...phone, rect: { ...phone.rect, x: 200, w: 100 } };
    const narrow = { ...block, alignLeftPt: 250, alignWidthPt: 20 };
    const result = neighbourBoxWidth(geometry(narrow), [overlapping]);
    expect(result.left).toBe(block.rect.x);
    expect(result.width).toBeCloseTo(block.rect.w);
  });

  it('leaves left-aligned blocks alone', () => {
    expect(neighbourBoxWidth(geometry({ ...block, align: 'left' }), [phone]))
      .toEqual({ left: block.rect.x, width: block.rect.w });
  });

  it('uses a moved saved rectangle and never cuts into it', () => {
    const moved = {
      pageIndex: 0,
      rect: { x: 330, y: 100, w: 70, h: 12 },
      align: 'right' as const,
      alignLeftPt: 300,
      alignWidthPt: 200,
    };
    const right = { ...phone, rect: { ...phone.rect, x: 450 } };
    expect(neighbourBoxWidth(moved, [right])).toEqual({ left: 300, width: 150 });

    const touching = { ...right, rect: { ...right.rect, x: 400 } };
    expect(neighbourBoxWidth(moved, [touching])).toEqual({ left: 300, width: 100 });
  });
});

describe.skipIf(!reachEnabled)('Task 74 Revision 2 neighbour reach', () => {
  it('narrows the same corpus pieces on first edit and re-edit', async () => {
    const [{ getDocument }, { detectRuleLines }, { extractTextRuns, groupRunsIntoBlocks }] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('@/lib/pdf/ruleLines'),
      import('@/lib/pdf/textContent'),
    ]);
    const baseline = JSON.parse(await readFile(reachBaselinePath, 'utf8')) as ReachBaseline;
    let nonLeft = 0;
    let firstNarrowed = 0;
    let reEditNarrowed = 0;

    for (const [file, expected] of Object.entries(baseline.files)) {
      const document = await getDocument({
        data: new Uint8Array(await readFile(file)),
        verbosity: 0,
      }).promise;
      try {
        for (const expectedPage of expected.pages) {
          const page = await document.getPage(expectedPage.pageIndex + 1);
          const [runs, ruleLines] = await Promise.all([
            extractTextRuns(page, expectedPage.pageIndex),
            detectRuleLines(page, expectedPage.pageIndex),
          ]);
          const blocks = groupRunsIntoBlocks(runs, { ruleLines });
          for (const candidate of blocks) {
            const align = candidate.align ?? 'left';
            if (align === 'left') continue;
            nonLeft += 1;
            const input = {
              pageIndex: candidate.pageIndex,
              rect: candidate.rect,
              align,
              alignLeftPt: candidate.alignLeftPt ?? candidate.rect.x,
              alignWidthPt: candidate.alignWidthPt ?? candidate.rect.w,
            };
            const neighbours = blocks.filter((entry) => entry !== candidate);
            const first = neighbourBoxWidth(input, neighbours);
            const reEdit = neighbourBoxWidth({ ...input, rect: { ...candidate.rect } }, neighbours);
            if (first.width < input.alignWidthPt - 0.01) firstNarrowed += 1;
            if (reEdit.width < input.alignWidthPt - 0.01) reEditNarrowed += 1;
          }
        }
      } finally {
        await document.destroy();
      }
    }

    // 475 before Task 74 Step 2 Revision 2. Removing the full-stop paragraph
    // split rejoined 65 lone fragments into the paragraphs they belong to (54
    // left, 10 centred, 1 right) and formed 6 joined centred blocks, so 416.
    // Every one of the 65 was confirmed present, word for word, inside a larger
    // block; none was lost. A drop here means fragments joined, not text vanished.
    expect(nonLeft).toBe(416);
    expect(firstNarrowed).toBe(85);
    expect(reEditNarrowed).toBe(firstNarrowed);
    process.stdout.write(
      `TASK74 NEIGHBOUR REACH first ${firstNarrowed}/${nonLeft}`
      + ` | re-edit ${reEditNarrowed}/${nonLeft}`
      + ' | prior prototype survey 258/450\n',
    );
  }, 600_000);
});
