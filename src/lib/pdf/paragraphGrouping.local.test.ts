import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns, groupRunsIntoBlocks, type TextBlock, type TextLine } from './textContent';
import { detectRuleLines } from './ruleLines';
import { detectPageGraphicRegions } from './shapeMarkers';
import { detectBulletListFromRegions } from './bulletList';
import { isTableNumber, startsWithBulletMarker } from './textUnits';
import { paragraphSeedText } from '@/lib/edit/paragraphSeed';
import { sourceSpansForTextBlock } from '@/lib/edit/richText';

const enabled = process.env.TASK74_GROUPING === '1' && existsSync('tmp/tables/baseline.json');
// Freeze the measured spacing-rule report. Every bridge is named with its
// geometry; new additions cannot silently change the accepted corpus.
const reviewedUniformDigest = 'f92c47a8798c01940f261bc49406d73d026b085d7ae33d4908004a6f54263dce';
const key = (line: TextLine) => JSON.stringify([line.pageIndex, line.baselineY, line.rect.x, line.text]);
function pairs(blocks: readonly TextBlock[]) {
  return new Map(blocks.flatMap((block) => block.lines.slice(1).map((line, index) => (
    [JSON.stringify([key(block.lines[index]!), key(line)]), [block.lines[index]!, line]] as const
  ))));
}

/** Individually reviewed boundaries. Unknown additions fail rather than being auto-explained. */
function reviewedReason(file: string, page: number, upper: string, lower: string): string | undefined {
  if (/ladakh(?:-original)?\.pdf$/u.test(file) && [3, 4].includes(page)) {
    const reviewed = new Map([
      ['Highlights: High altitude arrival, rest, mountain', 'DAY-1: the same day’s bold Highlights follow its regular sentence.'],
      ['monasteries to river confluences, ending with a', 'DAY-2: monasteries did not fit in the preceding display line.'],
      ['golden sunset at Shanti Stupa. Highlights: Hall of', 'DAY-2: the mixed-weight sunset/Highlights line continues the same day.'],
      ['peaks. Highlights: Khardung La Pass, Hunder', 'DAY-3: peaks completes snow peaks, followed by inline Highlights.'],
      ['Highlights: Diskit Monastery, Pangong Lake', 'DAY-4: the same day’s bold Highlights follow its regular sentence.'],
      ['silence. Highlights: Chushul route, Rezang La', 'DAY-5: silence completes valor and silence before inline Highlights.'],
      ['Extreme altitude drive, panoramic views,', 'DAY-6: the bold text continues the preceding Highlights label.'],
      ['Highlights: Scenic drive, Korzok village,', 'DAY-7: the same day’s bold Highlights follow its regular sentence.'],
      ['Ladakh’s magic. Highlights: Puga Valley,', 'DAY-8: the mixed-weight line completes one last glimpse of Ladakh’s magic.'],
      ['memories that refuse to fade. Highlights:', 'DAY-9: memories completes the departure sentence, followed by Highlights.'],
    ]);
    return reviewed.get(lower);
  }
  if (/ziro|Ziro/u.test(file) && page === 14 && upper === 'landslides, government restrictions, or any unforeseen'
    && lower === 'circumstances') return 'The wrapped word circumstances completes unforeseen circumstances; no new list item.';
  if (file === 'tmp/pdfs/task52-merge-qa/sample-goa-merged.pdf' && page === 2
    && upper === 'ride a 4WD jeep up the volcanic terrain to a scenic viewpoint near the'
    && lower === 'summit. From there, enjoy panoramic views of the sunrise over Lake Batur,') {
    return 'The wrapped summit completes viewpoint near the summit within the same itinerary paragraph.';
  }
  if (file === 'tmp/text-doubling/corporate-edited-3.pdf') {
    if (page === 68 && upper === 'Securities and Exchange Board of India (SEBI) on 2 September, 2015 issued the SEBI (Listing'
      && lower === 'Obligations and Disclosure Requirements) Regulations, 2015 (‘Listing Regulations’) with the aim of') {
      return 'The next display line continues the SEBI regulation title inside the same sentence.';
    }
    if (page === 68 && upper === 'Obligations and Disclosure Requirements) Regulations, 2015 (‘Listing Regulations’) with the aim of'
      && lower === 'bringing the basic framework governing the regime of listed entities in line with the Companies Act, 2013') {
      return 'bringing completes with the aim of within the same SEBI regulation paragraph.';
    }
    if (page === 83 && upper === 'Note: Corporate Social Responsibility is a requirement for companies meeting the above criteria. On the other'
      && lower === 'hand, Section 8 Companies are incorporated solely for not-for-profit purposes.') {
      return 'hand completes On the other hand within the same explanatory note.';
    }
  }
}

describe.runIf(enabled)('Task 74 Step 5c.2 paragraph grouping corpus', () => {
  it('lists every new boundary and preserves every old join and list item', { timeout: 3_600_000 }, async () => {
    const baseline = JSON.parse(await readFile('tmp/tables/baseline.json', 'utf8')) as {
      files: Record<string, { pages: { pageIndex: number }[] }>;
    };
    const files = [...Object.keys(baseline.files), ...['tmp/compress-tests/ladakh-original.pdf', 'tmp/ziro-check.pdf']
      .filter((file) => existsSync(file) && !baseline.files[file])];
    const changes: { file: string; page: number; upper: string; lower: string; kind: string; rule: string; verdict: string; reason: string }[] = [];
    const listChanges: { file: string; page: number; before: string[][]; after: string[][] }[] = [];
    let beforeCount = 0, afterCount = 0, lists = 0;
    for (const file of files) {
      const document = await getDocument({ data: new Uint8Array(await readFile(file)), verbosity: 0, fontExtraProperties: true }).promise;
      try {
        const pages = baseline.files[file]?.pages.map((p) => p.pageIndex)
          ?? Array.from({ length: document.numPages }, (_, index) => index);
        for (const pageIndex of pages) {
          const page = await document.getPage(pageIndex + 1);
          const [runs, ruleLines, regions] = await Promise.all([
            extractTextRuns(page, pageIndex), detectRuleLines(page, pageIndex), detectPageGraphicRegions(page, pageIndex),
          ]);
          // Freeze Changes 1–9 here; Change 10's live partition has its own corpus guard.
          const options = { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions], preserveParagraphGaps: true };
          const before = groupRunsIntoBlocks(runs, { ...options, preserveFillerSplits: true, preserveBulletTails: true });
          const after = groupRunsIntoBlocks(runs, options);
          const tailsOnly = groupRunsIntoBlocks(runs, { ...options, preserveFillerSplits: true });
          const tailPairs = pairs(tailsOnly);
          beforeCount += before.length; afterCount += after.length;
          const oldPairs = pairs(before), newPairs = pairs(after);
          for (const [pair, [upper, lower]] of newPairs) {
            if (oldPairs.has(pair)) continue;
            const reason = reviewedReason(file, pageIndex + 1, upper.text, lower.text)
              ?? `Change 7 spacing-led non-list bridge: gap ${(upper.baselineY - lower.baselineY).toFixed(2)} pt; sizes ${upper.style.fontSizePt.toFixed(2)}/${lower.style.fontSizePt.toFixed(2)}; x ${upper.rect.x.toFixed(2)}/${lower.rect.x.toFixed(2)}; overlapping extents. Weight, item starts and shortness are intentionally not boundaries.`;
            changes.push({ file, page: pageIndex + 1, upper: upper.text, lower: lower.text, kind: 'JOIN', rule: 'uniform',
              verdict: 'unreviewed', reason });
            expect(isTableNumber(upper.text) || isTableNumber(lower.text), `${file}: number cell`).toBe(false);
            expect(startsWithBulletMarker(lower.text), `${file}: new bullet join`).toBe(false);
          }
          for (const [pair, [upper, lower]] of oldPairs) if (!newPairs.has(pair)) {
            const approvedTail = !tailPairs.has(pair);
            changes.push({ file, page: pageIndex + 1, upper: upper.text, lower: lower.text, kind: 'SPLIT', rule: approvedTail ? 'bullet-tail' : 'old',
              verdict: approvedTail ? 'right' : 'wrong', reason: approvedTail ? `Change 9: line x ${lower.rect.x.toFixed(2)} falls left of its preceding bullet; it is not part of that item.` : 'An old adjacent pair was broken.' });
          }
          const listItems = (blocks: readonly TextBlock[]) => blocks
            .map((block) => detectBulletListFromRegions(block, regions.imageRegions, regions.shapeMarkerRegions))
            .filter((list) => list !== null).map((list) => list.items.map((item) => item.text));
          const oldItems = listItems(before);
          lists += oldItems.length;
          const tailItems = listItems(tailsOnly), newItems = listItems(after);
          expect(tailItems.length, `${file} p${pageIndex + 1}: Change 9 list count`).toBe(oldItems.length);
          expect(newItems, `${file} p${pageIndex + 1}: Change 7 freezes whole corrected lists`).toEqual(tailItems);
          if (JSON.stringify(newItems) !== JSON.stringify(oldItems)) listChanges.push({ file, page: pageIndex + 1, before: oldItems, after: newItems });
          for (const block of after) {
            const seed = paragraphSeedText(block);
            const spans = sourceSpansForTextBlock(block, seed);
            const originalSpans = sourceSpansForTextBlock(block);
            if (originalSpans) expect(spans?.map(span => span.text).join(''), `${file} p${pageIndex + 1}: source styles survive mixed breaks`).toBe(seed);
          }
          if (/ladakh-original\.pdf$/u.test(file) && [2, 3].includes(pageIndex)) {
            const days = after.filter((block) => block.lines.length > 1 && block.text.includes('Highlights:'));
            expect(days.length, `Ladakh p${pageIndex + 1}: all days`).toBe(pageIndex === 2 ? 4 : 5);
            expect(days.every((block) => !/^Highlights:/u.test(block.text)), 'Highlights are not detached').toBe(true);
          }
        }
      } finally { await document.destroy(); }
    }
    const uniformChanges = changes.filter((change) => change.rule === 'uniform');
    const uniformDigest = createHash('sha256').update(JSON.stringify(uniformChanges.map(({file, page, upper, lower}) => [file, page, upper, lower]).sort())).digest('hex');
    if (uniformDigest === reviewedUniformDigest) uniformChanges.forEach((change) => { change.verdict = 'right'; });
    const summary = { files: files.length, boxesBefore: beforeCount, boxesAfter: afterCount, lists, uniformDigest,
      joins: changes.filter((change) => change.kind === 'JOIN').length,
      splits: changes.filter((change) => change.kind === 'SPLIT').length, listChanges: listChanges.length };
    await writeFile('tmp/pdfs/task74-grouping-789.json', JSON.stringify({ summary, changes, listChanges }, null, 2));
    process.stdout.write(`${JSON.stringify(summary)}\n${changes.map((change) => (
      `${change.kind}/${change.rule} [${change.verdict}] ${change.file} p${change.page}: ${change.upper} / ${change.lower} — ${change.reason}`
    )).join('\n')}\n`);
    expect(changes.filter(change => change.kind === 'SPLIT' && change.rule !== 'bullet-tail'), 'No unapproved split').toEqual([]);
    expect(changes.filter(change => change.kind === 'SPLIT').map(change => [change.file, change.page])).toEqual([
      ['tmp/pdfs/task52-merge-qa/sample-goa-merged.pdf', 4],
      ['tmp/text-doubling/corporate-edited-3.pdf', 39],
      ['tmp/text-doubling/corporate-edited-3.pdf', 76],
      ['tmp/text-doubling/corporate-edited-3.pdf', 80],
      ['tmp/text-doubling/corporate-edited-3.pdf', 82],
      ['tmp/text-doubling/delhi-tour.pdf', 4],
    ]);
    expect(changes.filter((change) => change.verdict !== 'right'), 'Every addition is individually reviewed').toEqual([]);
    expect(uniformDigest, 'Uniform additions match the individually inspected report').toBe(reviewedUniformDigest);
    expect(lists).toBe(151);
  });
});
