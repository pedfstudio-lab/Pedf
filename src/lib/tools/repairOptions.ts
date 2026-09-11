import { fileKey } from './organizePlan';
import type { Inspection } from './repairInspect';
import type { ToolOptions } from './types';

export type StoredInspection = Inspection & { fileKey: string };

export interface RepairOptionsValue extends ToolOptions {
  inspection?: StoredInspection;
  repairAnyway: boolean;
  acceptSignatureLoss: boolean;
}

export const DEFAULT_REPAIR_OPTIONS: RepairOptionsValue = {
  repairAnyway: false,
  acceptSignatureLoss: false,
};

function parseInspection(value: unknown): StoredInspection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.fileKey !== 'string') return undefined;
  if (source.kind === 'not-pdf' || source.kind === 'locked') {
    return { kind: source.kind, fileKey: source.fileKey };
  }
  if (source.kind === 'healthy' && Number.isInteger(source.pageCount) && typeof source.signed === 'boolean') {
    return { kind: 'healthy', pageCount: Number(source.pageCount), signed: source.signed, fileKey: source.fileKey };
  }
  if (source.kind === 'damaged' && Array.isArray(source.badPages) && Array.isArray(source.problems)
    && source.badPages.every(Number.isInteger) && source.problems.every((problem) => typeof problem === 'string')
    && typeof source.signed === 'boolean') {
    const pageCount = Number.isInteger(source.pageCount) ? Number(source.pageCount) : undefined;
    return {
      kind: 'damaged',
      ...(pageCount === undefined ? {} : { pageCount }),
      badPages: source.badPages.map(Number),
      problems: source.problems as string[],
      signed: source.signed,
      fileKey: source.fileKey,
    };
  }
  return undefined;
}

export function parseRepairOptions(options: ToolOptions): RepairOptionsValue {
  return {
    inspection: parseInspection(options.inspection),
    repairAnyway: options.repairAnyway === true,
    acceptSignatureLoss: options.acceptSignatureLoss === true,
  };
}

export function repairProblem(options: ToolOptions, inputs: File[]): string | undefined {
  const file = inputs[0];
  const value = parseRepairOptions(options);
  if (!file || !value.inspection || value.inspection.fileKey !== fileKey(file)) return 'Checking your file…';
  const inspection = value.inspection;
  if (inspection.kind === 'not-pdf') {
    return "This isn't a PDF file. It may be a web page or another file saved with a .pdf name.";
  }
  if (inspection.kind === 'locked') {
    return "This file is password-protected or restricted, not damaged. Repair can't change it.";
  }
  if (inspection.kind === 'healthy' && !value.repairAnyway) {
    return 'This file looks healthy — no repair needed.';
  }
  if (inspection.signed && !value.acceptSignatureLoss) {
    return 'Tick the box to confirm the digital signature will stop being valid.';
  }
}
