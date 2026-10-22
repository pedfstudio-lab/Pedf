import type { CoverEdit, PdfRect, TextEdit } from '@/lib/export/types';
import type { TextBlock, TextLine, TextRun } from './textContent';

const ORDINAL = /^(st|nd|rd|th)$/iu;
const NUMBER_END = /(?:^|[^\p{L}\p{N}])(\d+)$/u;
const baseline = (run: TextRun) => run.metrics?.baselineY ?? run.rect.y;
const right = (run: TextRun) => run.rect.x + run.rect.w;
const shadowTolerance = (run: TextRun) => Math.max(1, run.style.fontSizePt * 0.11);
const horizontal = (run: TextRun) => !run.metrics || Math.abs(run.metrics.matrix[1]) < 1e-6 && Math.abs(run.metrics.matrix[2]) < 1e-6;

export interface AttachedOrdinal {
  readonly number: string;
  readonly text: string;
  readonly run: TextRun;
  readonly copies: readonly TextRun[];
  readonly body: TextRun;
  readonly owner: TextBlock;
}

/** Transient editor input, never a replacement for page text grouping or a saved field. */
export interface OrdinalEditorPlan {
  readonly source: TextBlock;
  readonly members: readonly TextBlock[];
  readonly ordinals: readonly AttachedOrdinal[];
  readonly originals: readonly TextRun[];
  readonly editor: TextBlock;
}

function sameLayer(a: TextRun, b: TextRun): boolean {
  return a.pageIndex === b.pageIndex && Math.abs(baseline(a) - baseline(b)) <= Math.max(2, shadowTolerance(a))
    && Math.abs(a.style.fontSizePt - b.style.fontSizePt) <= Math.max(0.2, a.style.fontSizePt * 0.03);
}

function shadowCopy(a: TextRun, b: TextRun): boolean {
  return a.text.trim() === b.text.trim() && sameLayer(a, b)
    && Math.abs(a.rect.x - b.rect.x) <= shadowTolerance(a)
    && Math.abs(a.rect.w - b.rect.w) <= shadowTolerance(a);
}

/** Collapse only overlapping duplicate paint, including a combined overprint of split runs. */
function foregroundRuns(runs: readonly TextRun[], order: ReadonlyMap<TextRun, number>): TextRun[] {
  const unique: TextRun[] = [];
  for (const run of [...new Set(runs)].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))) {
    const previous = unique.findIndex(candidate => shadowCopy(candidate, run));
    if (previous >= 0) unique[previous] = run;
    else unique.push(run);
  }
  return unique.filter(run => !unique.some(other => other !== run && sameLayer(run, other)
    && other.text.trim().length > run.text.trim().length
    && ((other.text.trim().startsWith(run.text.trim()) && Math.abs(other.rect.x - run.rect.x) <= shadowTolerance(run))
      || (other.text.trim().endsWith(run.text.trim()) && Math.abs(right(other) - right(run)) <= shadowTolerance(run)))))
    .sort((a, b) => a.rect.x - b.rect.x);
}

function prefixWidth(run: TextRun, count: number): number {
  const widths = run.characterWidthsPt;
  if (widths?.length === [...run.text].length) return widths.slice(0, count).reduce((sum, value) => sum + value, 0);
  const glyphs = run.metrics?.glyphs;
  if (glyphs?.length === run.text.length) return count >= glyphs.length ? run.rect.w : glyphs[count]?.offsetPt ?? 0;
  return run.rect.w * count / Math.max(1, run.text.length);
}

function editorLine(lines: readonly TextLine[], ordinals: readonly AttachedOrdinal[], order: ReadonlyMap<TextRun, number>): TextLine | undefined {
  const first = lines[0]!;
  if (!ordinals.length) return first;
  const body = foregroundRuns(lines.flatMap(line => line.runs), order);
  const insertions = new Map<TextRun, { offset: number; ordinal: AttachedOrdinal }[]>();
  for (const ordinal of ordinals) {
    const positions = body.flatMap(run => [...run.text.matchAll(/(?:^|[^\p{L}\p{N}])(\d+)(?=$|[^\p{L}\p{N}])/gu)]
      .filter(match => match[1] === ordinal.number).map(match => {
        const offset = match.index! + match[0].length;
        return { run, offset, distance: Math.abs(run.rect.x + prefixWidth(run, offset) - ordinal.run.rect.x) };
      })).sort((a, b) => a.distance - b.distance);
    const position = positions[0];
    if (!position) return undefined;
    const items = insertions.get(position.run) ?? [];
    if (items.some(item => item.offset === position.offset)) return undefined;
    items.push({ offset: position.offset, ordinal }); insertions.set(position.run, items);
  }
  const result: TextRun[] = [];
  let x = Math.min(...body.map(run => run.rect.x));
  const emit = (text: string, source: TextRun, width: number) => {
    if (!text) return;
    result.push({ pageIndex: first.pageIndex, text, style: source.style,
      rect: { x, y: first.baselineY, w: width, h: source.style.fontSizePt } });
    x += width;
  };
  body.forEach((run, index) => {
    const previous = body[index - 1];
    if (previous && run.rect.x - right(previous) > Math.max(0.75, run.style.fontSizePt * 0.08)
      && !/^[,.;:!?%)}\]]/u.test(run.text.trim())) emit(' ', run, run.spaceWidthPt ?? run.style.fontSizePt * 0.25);
    let offset = 0;
    for (const item of (insertions.get(run) ?? []).sort((a, b) => a.offset - b.offset)) {
      emit(run.text.slice(offset, item.offset), run, prefixWidth(run, item.offset) - prefixWidth(run, offset));
      emit(item.ordinal.text, item.ordinal.run, item.ordinal.run.rect.w);
      offset = item.offset;
    }
    emit(run.text.slice(offset), run, run.rect.w - prefixWidth(run, offset));
  });
  // No source metrics: an edited/moved date must draw the small letters at the
  // line baseline, never reuse their old raised glyph origins.
  return { ...first, text: result.map(run => run.text).join(''), runs: result, metrics: undefined };
}

function bounds(rects: readonly PdfRect[]): PdfRect {
  const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
  return { x, y, w: Math.max(...rects.map(rect => rect.x + rect.w)) - x,
    h: Math.max(...rects.map(rect => rect.y + rect.h)) - y };
}

/** Exact ordinal pieces + smaller face + positive rise + immediate numeric left neighbour. */
export function attachedOrdinals(blocks: readonly TextBlock[], paintOrder?: readonly TextRun[]): OrdinalEditorPlan[] {
  const entries = blocks.flatMap(owner => owner.lines.flatMap(line => line.runs.map(run => ({ owner, line, run }))));
  const order = new Map((paintOrder ?? entries.map(entry => entry.run)).map((run, index) => [run, index]));
  const small = entries.filter(entry => ORDINAL.test(entry.run.text.trim()) && horizontal(entry.run)
    && entry.owner.lines.every(line => line.runs.every(run => ORDINAL.test(run.text.trim()))));
  const clusters: typeof small[] = [];
  for (const entry of small) {
    const cluster = clusters.find(values => values.some(value => shadowCopy(value.run, entry.run)));
    if (cluster) cluster.push(entry); else clusters.push([entry]);
  }
  const attachments: AttachedOrdinal[] = [];
  for (const cluster of clusters) {
    const run = [...cluster].sort((a, b) => (order.get(b.run) ?? 0) - (order.get(a.run) ?? 0))[0]!.run;
    const candidates = entries.flatMap(entry => {
      const body = entry.run, match = body.text.trimEnd().match(NUMBER_END);
      if (!match || body.pageIndex !== run.pageIndex || !horizontal(body) || run.style.fontSizePt > body.style.fontSizePt * 0.8) return [];
      const rise = baseline(run) - baseline(body), gap = run.rect.x - right(body), size = body.style.fontSizePt;
      if (rise < Math.max(1.5, size * 0.1) || rise > size * 0.8 || gap < -Math.max(2, size * 0.12) || gap > Math.max(1, size * 0.3)) return [];
      return [{ ...entry, number: match[1]!, gap: Math.abs(gap) }];
    }).sort((a, b) => Math.abs(a.gap - b.gap) > 0.1 ? a.gap - b.gap : a.run.text.length - b.run.text.length);
    const target = candidates[0];
    if (target) attachments.push({ number: target.number, text: run.text.trim(), run,
      copies: [...new Set(cluster.map(entry => entry.run))], body: target.run, owner: target.owner });
  }
  // Only ordinal-owning date boxes can join, and only when their body bounds
  // already overlap (split shadow paint). No page-wide grouping is changed.
  const groups: TextBlock[][] = [];
  for (const owner of new Set(attachments.map(value => value.owner))) {
    const touching = groups.filter(group => group.some(other => other.pageIndex === owner.pageIndex
      && Math.abs(other.topBaselineY - owner.topBaselineY) <= Math.max(2, owner.style.fontSizePt * 0.12)
      && Math.min(other.rect.x + other.rect.w, owner.rect.x + owner.rect.w) > Math.max(other.rect.x, owner.rect.x)));
    if (!touching.length) groups.push([owner]);
    else { touching[0]!.push(owner, ...touching.slice(1).flat()); touching.slice(1).forEach(group => groups.splice(groups.indexOf(group), 1)); }
  }
  return groups.flatMap(group => {
    const owners = group.sort((a, b) => a.rect.x - b.rect.x), source = owners[0]!;
    const ordinals = attachments.filter(value => owners.includes(value.owner));
    const ordinalRuns = new Set(ordinals.flatMap(value => value.copies));
    const ordinalBlocks = blocks.filter(block => block.lines.some(line => line.runs.some(run => ordinalRuns.has(run))));
    const members = [...new Set([...owners, ...ordinalBlocks])];
    const rows: TextLine[][] = [];
    for (const line of owners.flatMap(owner => owner.lines)) {
      const row = rows.find(values => Math.abs(values[0]!.baselineY - line.baselineY) <= Math.max(2, line.style.fontSizePt * 0.12));
      if (row) row.push(line); else rows.push([line]);
    }
    const lines = rows.sort((a, b) => b[0]!.baselineY - a[0]!.baselineY).map(row => editorLine(row,
      ordinals.filter(value => row.some(line => line.runs.includes(value.body))), order));
    if (lines.some(line => !line)) return [];
    const present = lines as TextLine[];
    return [{ source, members, ordinals, originals: [...new Set(members.flatMap(block => block.lines.flatMap(line => line.runs)))],
      editor: { ...source, rect: owners.length === 1 ? source.rect : bounds(owners.map(owner => owner.rect)),
        text: present.map(line => line.text).join('\n'), lines: present } }];
  });
}

/** Keep the existing cover count/anchor/z transaction; add exact physical source targets. */
export function ordinalRemovalCovers(plan: OrdinalEditorPlan, covers: readonly CoverEdit[], texts: readonly TextEdit[] = []): CoverEdit[] {
  const key = (text: string, rect: PdfRect) => JSON.stringify([text, rect.x, rect.y, rect.w, rect.h]);
  const retained = new Set(texts.flatMap(text => text.composition?.pieces.flatMap(piece =>
    piece.sourceVisible && piece.sourceRect ? [key(piece.text, piece.sourceRect)] : []) ?? []));
  const replaces = plan.originals.filter(run => !retained.has(key(run.text, run.rect)))
    .map(run => ({ text: run.text, rect: { ...run.rect } }));
  return covers.map(cover => ({ ...cover, replaces }));
}

/** Exported dates are already on the baseline; recognize their existing mixed sizes, without attaching anything. */
export function hasInlineOrdinal(block: TextBlock): boolean {
  return block.lines.some(line => line.runs.some(run => ORDINAL.test(run.text.trim()) && line.runs.some(body =>
    body !== run && NUMBER_END.test(body.text.trimEnd()) && run.style.fontSizePt <= body.style.fontSizePt * 0.8
    && Math.abs(baseline(run) - baseline(body)) <= Math.max(1, body.style.fontSizePt * 0.06)
    && run.rect.x - right(body) >= -Math.max(1, body.style.fontSizePt * 0.1)
    && run.rect.x - right(body) <= body.style.fontSizePt * 0.3)));
}
