import type { CoverEdit, PdfRect } from '@/lib/export/types';
import type { RuleLine } from '@/lib/pdf/ruleLines';
import { coverRectForRuleLine } from './buildLineEdits';

function sameRect(left: PdfRect, right: PdfRect): boolean {
  return Math.abs(left.x - right.x) < 0.01 && Math.abs(left.y - right.y) < 0.01
    && Math.abs(left.w - right.w) < 0.01 && Math.abs(left.h - right.h) < 0.01;
}

/**
 * Is this cover a later line of the same text edit as the cover just below it
 * in z? A picture or rule line deleted just before a text edit also leaves a
 * cover at z-1, but that cover belongs to the delete, not to the text box.
 */
export function continuesCoverRun(
  cover: CoverEdit,
  coversByZ: ReadonlyMap<number, CoverEdit>,
  ruleLines: readonly RuleLine[],
): boolean {
  const before = coversByZ.get(cover.z - 1);
  if (!before) return false;
  if (before.replacesImages?.length && !before.replaces?.length) return false;
  return !ruleLines.some((line) => line.pageIndex === before.pageIndex && sameRect(before.rect, coverRectForRuleLine(line)));
}
