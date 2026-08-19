import type { CoverEdit, LineEdit, PdfRect } from '@/lib/export/types';
import type { RuleLine } from '@/lib/pdf/ruleLines';

export const LINE_COVER_PADDING_PT = 1.5;

let fallbackId = 0;

function id(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackId += 1;
  return `line-edit-${fallbackId}`;
}

export function ruleLineRect(line: RuleLine, paddingPt = 0): PdfRect {
  const radius = line.thicknessPt / 2 + paddingPt;
  const left = Math.min(line.x1, line.x2) - radius;
  const bottom = Math.min(line.y1, line.y2) - radius;
  const right = Math.max(line.x1, line.x2) + radius;
  const top = Math.max(line.y1, line.y2) + radius;
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}

export function coverRectForRuleLine(line: RuleLine): PdfRect {
  return ruleLineRect(line, LINE_COVER_PADDING_PT);
}

function coverFor(line: RuleLine, z: number): CoverEdit {
  return {
    id: id(),
    kind: 'cover',
    pageIndex: line.pageIndex,
    rect: coverRectForRuleLine(line),
    z,
    sampleBackground: true,
  };
}

export function buildLineMove(
  line: RuleLine,
  dx: number,
  dy: number,
  z: number,
): { readonly cover: CoverEdit; readonly line: LineEdit } {
  const moved: RuleLine = {
    ...line,
    x1: line.x1 + dx,
    y1: line.y1 + dy,
    x2: line.x2 + dx,
    y2: line.y2 + dy,
  };
  return {
    cover: coverFor(line, z),
    line: {
      id: id(),
      kind: 'line',
      pageIndex: line.pageIndex,
      rect: ruleLineRect(moved),
      z: z + 1,
      x1: moved.x1,
      y1: moved.y1,
      x2: moved.x2,
      y2: moved.y2,
      thicknessPt: moved.thicknessPt,
      color: moved.color,
    },
  };
}

export function buildLineDelete(
  line: RuleLine,
  z: number,
): { readonly cover: CoverEdit } {
  return { cover: coverFor(line, z) };
}
