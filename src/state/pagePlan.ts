import type { Edit } from '@/lib/export/types';
import type { PageGeometry } from '@/lib/pdf/types';

export type PagePlanEntry =
  | { readonly id: string; readonly kind: 'source'; readonly sourceIndex: number }
  | {
      readonly id: string;
      readonly kind: 'blank';
      readonly widthPt: number;
      readonly heightPt: number;
    };

export type PagePlan = readonly PagePlanEntry[];

export interface PageOperationResult {
  readonly plan: PagePlan;
  readonly edits: Edit[];
}

export function createPagePlan(pageCount: number, newId: () => string): PagePlan {
  if (!Number.isInteger(pageCount) || pageCount < 0) {
    throw new RangeError(`page count must be a non-negative integer: ${pageCount}`);
  }
  return Array.from({ length: pageCount }, (_, sourceIndex) => ({
    id: newId(),
    kind: 'source' as const,
    sourceIndex,
  }));
}

function pageAt(plan: PagePlan, position: number): PagePlanEntry {
  if (!Number.isInteger(position) || position < 0 || position >= plan.length) {
    throw new RangeError(`invalid page position ${position}`);
  }
  const entry = plan[position];
  if (!entry) throw new RangeError(`missing page at position ${position}`);
  return entry;
}

function shiftEdits(edits: readonly Edit[], insertionIndex: number): Edit[] {
  return edits.map((edit) => (
    edit.pageIndex >= insertionIndex
      ? { ...edit, pageIndex: edit.pageIndex + 1 }
      : edit
  ));
}

/** Duplicate one live page immediately after itself, including its current edits. */
export function duplicatePage(
  plan: PagePlan,
  edits: readonly Edit[],
  position: number,
  newId: () => string,
): PageOperationResult {
  const original = pageAt(plan, position);
  const insertionIndex = position + 1;
  const copy = { ...original, id: newId() };
  const nextPlan = [
    ...plan.slice(0, insertionIndex),
    copy,
    ...plan.slice(insertionIndex),
  ];
  const shifted = shiftEdits(edits, insertionIndex);
  const clones = edits
    .filter((edit) => edit.pageIndex === position)
    .map((edit) => ({ ...edit, id: newId(), pageIndex: insertionIndex }));
  return { plan: nextPlan, edits: [...shifted, ...clones] };
}

/** Insert a same-size blank page immediately after the selected live page. */
export function insertBlankPage(
  plan: PagePlan,
  edits: readonly Edit[],
  position: number,
  size: { readonly widthPt: number; readonly heightPt: number },
  newId: () => string,
): PageOperationResult {
  pageAt(plan, position);
  if (!Number.isFinite(size.widthPt) || size.widthPt <= 0) {
    throw new RangeError(`blank page width must be positive: ${size.widthPt}`);
  }
  if (!Number.isFinite(size.heightPt) || size.heightPt <= 0) {
    throw new RangeError(`blank page height must be positive: ${size.heightPt}`);
  }

  const insertionIndex = position + 1;
  const entry: PagePlanEntry = {
    id: newId(),
    kind: 'blank',
    widthPt: size.widthPt,
    heightPt: size.heightPt,
  };
  return {
    plan: [...plan.slice(0, insertionIndex), entry, ...plan.slice(insertionIndex)],
    edits: shiftEdits(edits, insertionIndex),
  };
}

/** Remove one live page, discard its edits, and pull every later page back by one. */
export function deletePage(
  plan: PagePlan,
  edits: readonly Edit[],
  position: number,
): PageOperationResult {
  pageAt(plan, position);
  if (plan.length <= 1) throw new RangeError('cannot delete the last remaining page');

  return {
    plan: [...plan.slice(0, position), ...plan.slice(position + 1)],
    edits: edits
      .filter((edit) => edit.pageIndex !== position)
      .map((edit) => (
        edit.pageIndex > position
          ? { ...edit, pageIndex: edit.pageIndex - 1 }
          : edit
      )),
  };
}

export function planToGeometry(
  plan: PagePlan,
  originalPages: readonly PageGeometry[],
): PageGeometry[] {
  return plan.map((entry, pageIndex) => {
    if (entry.kind === 'blank') {
      return {
        pageIndex,
        widthPt: entry.widthPt,
        heightPt: entry.heightPt,
        rotation: 0,
        boxOffset: { x: 0, y: 0 },
      };
    }
    const source = originalPages[entry.sourceIndex];
    if (!source) throw new RangeError(`missing source geometry ${entry.sourceIndex}`);
    return { ...source, pageIndex };
  });
}

export function isIdentityPagePlan(plan: PagePlan | undefined, sourcePageCount: number): boolean {
  return plan === undefined || (
    plan.length === sourcePageCount
    && plan.every((entry, position) => (
      entry.kind === 'source' && entry.sourceIndex === position
    ))
  );
}
