import { ToolError } from './errors';

export const EMPTY_PAGE_RANGE_ERROR = 'Enter at least one page or range.';
export const PAGE_RANGE_FORMAT_ERROR = 'Use page numbers or ranges like 1-3, 5, 8-10.';
export const REVERSED_PAGE_RANGE_ERROR = 'Range start must be before its end.';

/**
 * Parse user-facing one-based page ranges into zero-based pdf-lib page indices.
 * Each comma-separated range remains its own output group.
 */
export function parsePageRanges(text: string, pageCount: number): number[][] {
  const input = text.trim();
  if (!input) throw new ToolError(EMPTY_PAGE_RANGE_ERROR);
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new ToolError('This PDF has no pages.');

  const groups = input.split(',');
  const ranges: number[][] = [];
  for (const group of groups) {
    const token = group.trim();
    if (!token) throw new ToolError(PAGE_RANGE_FORMAT_ERROR);
    const match = /^(\d+)\s*(?:[-–]\s*(\d+))?$/.exec(token);
    if (!match) throw new ToolError(PAGE_RANGE_FORMAT_ERROR);
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      throw new ToolError(`Page numbers must be between 1 and ${pageCount}.`);
    }
    if (start > end) throw new ToolError(REVERSED_PAGE_RANGE_ERROR);
    ranges.push(Array.from({ length: end - start + 1 }, (_, index) => start - 1 + index));
  }
  return ranges;
}

export function describePageIndices(indices: number[]): string {
  if (!indices.length) return '';
  const first = indices[0]! + 1;
  const last = indices[indices.length - 1]! + 1;
  return first === last ? String(first) : `${first}-${last}`;
}
