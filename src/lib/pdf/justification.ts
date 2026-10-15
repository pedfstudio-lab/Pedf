import type { TextBlock, TextLine } from './textContent';
import type { DrawnMarker } from './textUnits';
import { startsWithBulletMarker } from './textUnits';
import { detectBulletListFromRegions } from './bulletList';
import { sourceParagraphs } from '@/lib/edit/paragraphSeed';
import { runKey, wordGaps, type RawSpacing } from './wordSpacing';

export const JUSTIFICATION_RULE = Object.freeze({ edgeSpreadPt: 1, nearEdgeSpreadPt: 2, gapExcessPt: 0.1, minimumKnownGaps: 6, minimumKnownGapsPerEdgeLine: 2, maxCharacterSpacingPt: 0.01 });

export function sourceWordGaps(line: TextLine) {
  const raw = new Map<string, RawSpacing>();
  for (const run of line.runs) if (run.wordSpacing) raw.set(runKey(run.style.fontRef ?? '', run.text, run.rect.x, run.rect.y), run.wordSpacing);
  return wordGaps(line, raw);
}

/** The approved survey rule, evaluated only AFTER the existing grouping finishes. */
export function justificationEvidence(block: TextBlock, markers: readonly DrawnMarker[] = []) {
  const groups = sourceParagraphs({ ...block, align: 'left' }).lines;
  const full = groups.flatMap(group => group.slice(0, -1));
  const evidence = full.map(sourceWordGaps);
  const known = evidence.flatMap(line => line.measured.filter(gap => gap.excessPt !== null));
  const stretched = known.filter(gap => gap.excessPt! > JUSTIFICATION_RULE.gapExcessPt).length;
  const widestRight = Math.max(...block.lines.map(line => line.rect.x + line.rect.w));
  const spread = full.length ? widestRight - Math.min(...full.map(line => line.rect.x + line.rect.w)) : Infinity;
  const sizes = block.lines.flatMap(line => line.runs.map(run => run.style.fontSizePt));
  const bullet = block.lines.some(line => startsWithBulletMarker(line.text)) || Boolean(detectBulletListFromRegions(block, markers));
  const accepted = block.lines.length >= 2 && (block.align ?? 'left') === 'left' && !bullet && full.length >= 2
    && Math.max(...sizes) - Math.min(...sizes) <= 1
    && evidence.every(line => line.charSpacingPt <= JUSTIFICATION_RULE.maxCharacterSpacingPt)
    && spread <= JUSTIFICATION_RULE.edgeSpreadPt && known.length >= JUSTIFICATION_RULE.minimumKnownGaps
    && evidence.filter(line => line.measured.filter(gap => gap.excessPt !== null).length >= JUSTIFICATION_RULE.minimumKnownGapsPerEdgeLine).length >= 2
    && stretched > known.length / 2;
  return { accepted, groups, knownGaps: known.length, widerGaps: stretched, spread };
}

export function justifiedBlock(block: TextBlock, markers: readonly DrawnMarker[]): TextBlock {
  if (block.lines.length < 3 || (block.align ?? 'left') !== 'left') return block;
  const result = justificationEvidence(block, markers);
  if (!result.accepted) return block;
  const minimumWordGapsEm = result.groups.map(lines => {
    const gaps = lines.flatMap(line => sourceWordGaps(line).measured.filter(gap => gap.excessPt !== null)
      .map(gap => ({ ...gap, size: line.style.fontSizePt })));
    return gaps.some(gap => gap.excessPt! < 0) ? Math.max(0, Math.min(...gaps.map(gap => gap.gapPt / gap.size))) : undefined;
  });
  return { ...block, align: 'justify', paragraphMinimumWordGapsEm: minimumWordGapsEm };
}
