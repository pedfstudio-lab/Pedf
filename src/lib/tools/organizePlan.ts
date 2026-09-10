import { turnLeft, turnRight, type Turns } from './rotateOptions';

export type OrganizeEntry =
  | { id: string; kind: 'page'; fileKey: string; pageIndex: number; turns: Turns }
  | { id: string; kind: 'blank'; widthPt: number; heightPt: number; turns: 0 };

export type OrganizePlan = readonly OrganizeEntry[];
export interface OrganizeFileInfo { key: string; pageCount: number }
export interface PageSizePt { w: number; h: number }

const knownPageCounts = new WeakMap<File, number>();

export function fileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export function rememberPageCount(file: File, pageCount: number): void {
  if (Number.isInteger(pageCount) && pageCount >= 0) knownPageCounts.set(file, pageCount);
}

export function knownPageCount(file: File): number | undefined {
  return knownPageCounts.get(file);
}

export function createEntries(key: string, pageCount: number, newId: () => string): OrganizeEntry[] {
  if (!Number.isInteger(pageCount) || pageCount < 0) throw new RangeError('Page count must be a non-negative integer.');
  return Array.from({ length: pageCount }, (_, pageIndex) => ({
    id: newId(), kind: 'page' as const, fileKey: key, pageIndex, turns: 0 as const,
  }));
}

function entryAt(plan: OrganizePlan, position: number): OrganizeEntry {
  if (!Number.isInteger(position) || position < 0 || position >= plan.length) {
    throw new RangeError(`Invalid page position: ${position}.`);
  }
  return plan[position]!;
}

export function movePage(plan: OrganizePlan, from: number, to: number): OrganizePlan {
  entryAt(plan, from);
  const target = Math.max(0, Math.min(Math.trunc(to), plan.length - 1));
  if (from === target) return plan;
  const next = [...plan];
  const [entry] = next.splice(from, 1);
  next.splice(target, 0, entry!);
  return next;
}

export function rotatePage(plan: OrganizePlan, position: number, direction: 'left' | 'right'): OrganizePlan {
  const entry = entryAt(plan, position);
  const replacement: OrganizeEntry = entry.kind === 'blank'
    ? { ...entry, widthPt: entry.heightPt, heightPt: entry.widthPt }
    : { ...entry, turns: direction === 'left' ? turnLeft(entry.turns) : turnRight(entry.turns) };
  return plan.map((item, index) => index === position ? replacement : item);
}

export function removePage(plan: OrganizePlan, position: number): OrganizePlan {
  entryAt(plan, position);
  return [...plan.slice(0, position), ...plan.slice(position + 1)];
}

export function duplicatePage(plan: OrganizePlan, position: number, newId: () => string): OrganizePlan {
  const entry = entryAt(plan, position);
  const copy = { ...entry, id: newId() } as OrganizeEntry;
  return [...plan.slice(0, position + 1), copy, ...plan.slice(position + 1)];
}

export function insertBlankAfter(
  plan: OrganizePlan,
  position: number,
  size: PageSizePt,
  newId: () => string,
): OrganizePlan {
  entryAt(plan, position);
  if (!Number.isFinite(size.w) || size.w <= 0 || !Number.isFinite(size.h) || size.h <= 0) {
    throw new RangeError('Blank page dimensions must be positive.');
  }
  const blank: OrganizeEntry = {
    id: newId(), kind: 'blank', widthPt: size.w, heightPt: size.h, turns: 0,
  };
  return [...plan.slice(0, position + 1), blank, ...plan.slice(position + 1)];
}

export function reconcilePlan(
  plan: OrganizePlan,
  files: OrganizeFileInfo[],
  newId: () => string,
): OrganizePlan {
  const pageCounts = new Map(files.map((file) => [file.key, file.pageCount]));
  const next = plan.filter((entry) => entry.kind === 'blank'
    || (pageCounts.has(entry.fileKey) && entry.pageIndex < pageCounts.get(entry.fileKey)!));
  const present = new Set(next.flatMap((entry) => entry.kind === 'page' ? [entry.fileKey] : []));
  for (const file of files) {
    if (!present.has(file.key)) next.push(...createEntries(file.key, file.pageCount, newId));
  }
  return next;
}

export function isIdentityPlan(plan: OrganizePlan, files: OrganizeFileInfo[]): boolean {
  const expected = files.flatMap((file) => Array.from({ length: file.pageCount }, (_, pageIndex) => ({
    fileKey: file.key, pageIndex,
  })));
  return plan.length === expected.length && plan.every((entry, position) => {
    const source = expected[position];
    return entry.kind === 'page' && entry.turns === 0
      && entry.fileKey === source?.fileKey && entry.pageIndex === source.pageIndex;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validTurns(value: unknown): value is Turns {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 3;
}

export function parsePlan(value: unknown): OrganizePlan {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): OrganizeEntry[] => {
    if (!isRecord(entry) || !validId(entry.id)) return [];
    if (entry.kind === 'page' && typeof entry.fileKey === 'string' && entry.fileKey.length > 0
      && Number.isInteger(entry.pageIndex) && Number(entry.pageIndex) >= 0 && validTurns(entry.turns)) {
      return [{
        id: entry.id,
        kind: 'page',
        fileKey: entry.fileKey,
        pageIndex: Number(entry.pageIndex),
        turns: entry.turns,
      }];
    }
    if (entry.kind === 'blank' && Number.isFinite(entry.widthPt) && Number(entry.widthPt) > 0
      && Number.isFinite(entry.heightPt) && Number(entry.heightPt) > 0 && entry.turns === 0) {
      return [{
        id: entry.id,
        kind: 'blank',
        widthPt: Number(entry.widthPt),
        heightPt: Number(entry.heightPt),
        turns: 0,
      }];
    }
    return [];
  });
}
