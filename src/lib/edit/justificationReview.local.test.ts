import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractTextRuns, groupRunsIntoBlocks, mergeRunsIntoLines } from '@/lib/pdf/textContent';
import { detectRuleLines } from '@/lib/pdf/ruleLines';
import { detectPageGraphicRegions } from '@/lib/pdf/shapeMarkers';
import { detectBulletListFromRegions } from '@/lib/pdf/bulletList';
import { startsWithBulletMarker } from '@/lib/pdf/textUnits';
import { sourceParagraphs } from './paragraphSeed';
import { rawSpacing, wordGaps } from './positionBaseline.local.test';
import type { PdfRect } from '@/lib/export/types';

interface ReviewRow {
  status: 'accepted' | 'near-miss' | 'rejected'; file: string; page: number; blockIndex: number; text: string; rect: PdfRect;
  reasons: string[]; paragraphLineCounts: number[]; nonFinalLineIndexes: number[]; rightEdgeSpreadPt: number | null;
  knownGaps: number; widerGaps: number; ignoredUnmeasuredInternalGaps: number;
  lines: (ReturnType<typeof wordGaps> & { text: string; x: number; right: number; baseline: number })[];
}

// Diagnostic only. No production alignment or grouping decision is changed.
describe.runIf(process.env.TASK74_JUSTIFY_REVIEW === '1')('Step 5d revised justification review', () => {
  it('publishes accepted, rejected and near-miss boxes with their measured evidence', async () => {
    const frozen = JSON.parse(await readFile('tmp/5d/source-text-before.json', 'utf8')) as Record<string, { pageIndex: number; lines: string[] }[]>;
    const rows: ReviewRow[] = [];
    const thresholds = { edgeSpreadPt: 1, nearEdgeSpreadPt: 2, gapExcessPt: 0.1, minimumKnownGaps: 6, minimumKnownGapsPerEdgeLine: 2, maxCharacterSpacingPt: 0.01 };
    let pages = 0, lineCount = 0;
    for (const [file, entries] of Object.entries(frozen)) {
      const document = await getDocument({ data: new Uint8Array(await readFile(file)), verbosity: 0, fontExtraProperties: true }).promise;
      try {
        for (const entry of entries) {
          const page = await document.getPage(entry.pageIndex + 1);
          const [runs, ruleLines, regions, raw] = await Promise.all([extractTextRuns(page, entry.pageIndex), detectRuleLines(page, entry.pageIndex), detectPageGraphicRegions(page, entry.pageIndex), rawSpacing(page)]);
          const options = { ruleLines, markers: [...regions.imageRegions, ...regions.shapeMarkerRegions] };
          const extracted = mergeRunsIntoLines(runs, options).map(line => line.text);
          expect(extracted, `${file} p${entry.pageIndex + 1}`).toEqual(entry.lines); pages++; lineCount += extracted.length;
          for (const [blockIndex, block] of groupRunsIntoBlocks(runs, options).entries()) {
            if (block.lines.length < 2 || (block.align ?? 'left') !== 'left') continue;
            const groups = sourceParagraphs(block).lines, full = groups.flatMap(group => group.slice(0, -1));
            const fullIndexes = full.map(line => block.lines.indexOf(line));
            const measurements = block.lines.map(line => ({ text: line.text, x: line.rect.x, right: line.rect.x + line.rect.w, baseline: line.baselineY, ...wordGaps(line, raw) }));
            const evidence = fullIndexes.map(index => measurements[index]!);
            const known = evidence.flatMap(line => line.measured.filter(gap => gap.excessPt !== null));
            const stretched = known.filter(gap => gap.excessPt! > thresholds.gapExcessPt).length;
            const widestRight = Math.max(...measurements.map(line => line.right));
            const spread = full.length ? widestRight - Math.min(...evidence.map(line => line.right)) : null;
            const sizes = block.lines.flatMap(line => line.runs.map(run => run.style.fontSizePt));
            const bullet = block.lines.some(line => startsWithBulletMarker(line.text)) || Boolean(detectBulletListFromRegions(block, regions.imageRegions, regions.shapeMarkerRegions));
            const reasons = [];
            if (bullet) reasons.push('bullet-list-excluded');
            if (full.length < 2) reasons.push('fewer-than-two-non-final-lines');
            if (Math.max(...sizes) - Math.min(...sizes) > 1) reasons.push('mixed-size-heading-or-label');
            if (evidence.some(line => line.charSpacingPt > thresholds.maxCharacterSpacingPt)) reasons.push('explicit-character-spacing');
            if (spread === null || spread > thresholds.edgeSpreadPt) reasons.push('right-edges-do-not-agree');
            if (known.length < thresholds.minimumKnownGaps || evidence.filter(line => line.measured.filter(gap => gap.excessPt !== null).length >= thresholds.minimumKnownGapsPerEdgeLine).length < 2) reasons.push('insufficient-measured-gaps');
            if (stretched <= known.length / 2) reasons.push('measured-gaps-not-mostly-wider');
            const near = !bullet && full.length >= 2 && spread !== null && spread <= thresholds.nearEdgeSpreadPt
              && !reasons.includes('mixed-size-heading-or-label') && !reasons.includes('explicit-character-spacing');
            rows.push({ status: reasons.length === 0 ? 'accepted' : near ? 'near-miss' : 'rejected', file, page: entry.pageIndex + 1, blockIndex, text: block.text, rect: block.rect,
              reasons, paragraphLineCounts: groups.map(group => group.length), nonFinalLineIndexes: fullIndexes, rightEdgeSpreadPt: spread,
              knownGaps: known.length, widerGaps: stretched, ignoredUnmeasuredInternalGaps: evidence.reduce((sum, line) => sum + line.unmeasuredInternalSpaces, 0), lines: measurements });
          }
        }
      } finally { await document.destroy(); }
      process.stdout.write(`JUSTIFY REVIEW ${file}\n`);
    }
    const counts = { accepted: rows.filter(row => row.status === 'accepted').length, rejected: rows.filter(row => row.status === 'rejected').length, nearMisses: rows.filter(row => row.status === 'near-miss').length };
    const summary = { files: Object.keys(frozen).length, pages, lines: lineCount, boxes: rows.length, counts, thresholds,
      status: 'Diagnostic proposals, not an approved production detector. Unmeasured gaps are ignored, never counted as negative evidence.' };
    await writeFile('tmp/5d-review/justification-revised.json', JSON.stringify({ summary, rows }, null, 2));
    const sections = ['accepted', 'near-miss', 'rejected'].map(status => `## ${status}\n\n` + rows.filter(row => row.status === status).map(row => `### ${row.file} - page ${row.page}, box ${row.blockIndex}\n\n${row.text.replace(/\n/g, ' / ')}\n\nReasons: ${row.reasons.join(', ') || 'passes revised rule'}. Non-final lines: ${row.nonFinalLineIndexes.length}; edge spread: ${row.rightEdgeSpreadPt ?? 'unknown'} pt; measured wide gaps: ${row.widerGaps}/${row.knownGaps}.\n`).join('\n'));
    await writeFile('TASK74_5D_JUSTIFICATION_REVIEW.md', `# Step 5d revised justification list\n\nClient date: 2026-10-13. Branch: text-position. No production justification enabled.\n\n${JSON.stringify(summary, null, 2)}\n\n${sections.join('\n')}\n`);
    expect(lineCount).toBe(9315);
    const ladakh = rows.filter(row => row.file === 'tmp/compress-tests/ladakh-original.pdf' && row.page === 2);
    expect(ladakh.find(row => row.text.startsWith('Ladakh, for us'))?.status).toBe('accepted');
    expect(ladakh.find(row => row.text.startsWith('And then there are'))?.status).toBe('accepted');
    expect(rows.filter(row => row.text.startsWith('June (Including')).every(row => row.status === 'rejected')).toBe(true);
  }, 1_800_000);
});
