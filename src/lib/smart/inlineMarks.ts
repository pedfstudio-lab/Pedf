import type { TextSpan } from '@/lib/export/types';
import type { DetectedDate } from '@/lib/smart/dateDetect';

export interface InlineSegment {
  readonly text: string;
  readonly span?: TextSpan;
  readonly date?: DetectedDate;
}

interface IndexedSpan {
  readonly start: number;
  readonly end: number;
  readonly span?: TextSpan;
}

interface IndexedMark {
  readonly start: number;
  readonly end: number;
  readonly date?: DetectedDate;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

function hasWholeWordBoundaries(text: string, start: number, end: number): boolean {
  const before = text.slice(0, start).at(-1);
  const after = text[end];
  return (!before || !WORD_CHARACTER.test(before)) && (!after || !WORD_CHARACTER.test(after));
}

function overlaps(marks: readonly IndexedMark[], start: number, end: number): boolean {
  return marks.some((mark) => start < mark.end && end > mark.start);
}

function dateMarks(
  text: string,
  dates: readonly DetectedDate[],
): IndexedMark[] {
  const result: IndexedMark[] = [];
  const byRaw = new Map<string, DetectedDate[]>();
  for (const date of dates) {
    const values = byRaw.get(date.raw) ?? [];
    values.push(date);
    byRaw.set(date.raw, values);
  }
  const ordered = [...byRaw.entries()].sort(([left], [right]) => right.length - left.length);
  for (const [raw, detected] of ordered) {
    let fromIndex = 0;
    let occurrence = 0;
    while (fromIndex < text.length) {
      const start = text.indexOf(raw, fromIndex);
      if (start < 0) break;
      const end = start + raw.length;
      fromIndex = end;
      const date = detected[Math.min(occurrence, detected.length - 1)];
      occurrence += 1;
      if (
        date &&
        hasWholeWordBoundaries(text, start, end) &&
        !overlaps(result, start, end)
      ) {
        result.push({ start, end, date });
      }
    }
  }
  return result;
}

function indexedSpans(text: string, spans: readonly TextSpan[] | undefined): IndexedSpan[] {
  if (!spans || spans.map((span) => span.text).join('') !== text) {
    return text ? [{ start: 0, end: text.length }] : [];
  }
  let offset = 0;
  return spans.flatMap((span): IndexedSpan[] => {
    const start = offset;
    offset += span.text.length;
    return span.text ? [{ start, end: offset, span }] : [];
  });
}

function buildSegments(
  text: string,
  spans: readonly TextSpan[] | undefined,
  marks: readonly IndexedMark[],
): InlineSegment[] {
  if (!text) return [];
  const styled = indexedSpans(text, spans);
  const boundaries = [...new Set([
    0,
    text.length,
    ...styled.flatMap((span) => [span.start, span.end]),
    ...marks.flatMap((mark) => [mark.start, mark.end]),
  ])].sort((left, right) => left - right);

  const result: InlineSegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (start === undefined || end === undefined || end <= start) continue;
    const sourceSpan = styled.find((span) => start >= span.start && end <= span.end)?.span;
    const mark = marks.find((candidate) => start >= candidate.start && end <= candidate.end);
    const segmentText = text.slice(start, end);
    result.push({
      text: segmentText,
      ...(sourceSpan ? { span: { ...sourceSpan, text: segmentText } } : {}),
      ...(mark?.date ? { date: mark.date } : {}),
    });
  }
  return result;
}

export function markInlineSmartSegments(
  text: string,
  spans: readonly TextSpan[] | undefined,
  dates: readonly DetectedDate[],
): InlineSegment[] {
  return buildSegments(text, spans, dateMarks(text, dates));
}
