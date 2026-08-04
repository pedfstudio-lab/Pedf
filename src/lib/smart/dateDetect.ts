import type { PdfRect } from '@/lib/export/types';
import { mergeRunsIntoLines } from '@/lib/pdf/textContent';
import type { TextLine, TextRun } from '@/lib/pdf/textContent';

export interface DetectedDate {
  readonly raw: string;
  readonly startISO: string;
  readonly endISO?: string;
  readonly allDay: boolean;
  readonly pageIndex: number;
  readonly rect: PdfRect;
  readonly contextText: string;
  /** Alternate US-style interpretation for an ambiguous numeric date. */
  readonly monthDayStartISO?: string;
  readonly monthDayEndISO?: string;
}

interface TextSegment {
  readonly run: TextRun;
  readonly start: number;
  readonly end: number;
}

interface MappedLine {
  readonly text: string;
  readonly segments: readonly TextSegment[];
  readonly line: TextLine;
}

interface IndexedDetection {
  readonly start: number;
  readonly end: number;
  readonly detected: DetectedDate;
}

const MONTHS = new Map<string, number>([
  ['jan', 1], ['january', 1],
  ['feb', 2], ['february', 2],
  ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4],
  ['may', 5],
  ['jun', 6], ['june', 6],
  ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8],
  ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10],
  ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12],
] as const);

const MONTH_PATTERN =
  '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const NAMED_DATE_PATTERN = `([0-3]?\\d)\\s+(${MONTH_PATTERN})(?:\\s*,?\\s*(\\d{4}))?`;
const NUMERIC_DATE_PATTERN = '([0-3]?\\d)[/.]([01]?\\d)[/.](\\d{2}|\\d{4})';

function currentYear(): number {
  return new Date().getFullYear();
}

function normalizeYear(value: string | undefined): number {
  if (!value) return currentYear();
  const year = Number(value);
  if (value.length === 2) return year >= 70 ? 1900 + year : 2000 + year;
  return year;
}

function isoDate(year: number, month: number, day: number): string | undefined {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function unionRects(rects: readonly PdfRect[]): PdfRect {
  const first = rects[0];
  if (!first) return { x: 0, y: 0, w: 0, h: 0 };
  const left = Math.min(...rects.map((rect) => rect.x));
  const bottom = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const top = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: left, y: bottom, w: right - left, h: top - bottom };
}

function mappedLine(line: TextLine): MappedLine {
  let text = '';
  let previous: TextRun | undefined;
  const segments: TextSegment[] = [];

  for (const run of [...line.runs].sort((left, right) => left.rect.x - right.rect.x)) {
    const part = run.text.trim();
    if (!part) continue;
    if (previous) {
      const gap = run.rect.x - (previous.rect.x + previous.rect.w);
      const threshold = Math.max(
        0.75,
        Math.min(previous.style.fontSizePt, run.style.fontSizePt) * 0.08,
      );
      const punctuation = /^[,.;:!?%)}\]]/.test(part) || '([{/'.includes(text.at(-1) ?? '');
      if (gap > threshold && !punctuation) text += ' ';
    }
    const start = text.length;
    text += part;
    segments.push({ run, start, end: text.length });
    previous = run;
  }

  return { text, segments, line };
}

function matchRect(source: MappedLine, start: number, end: number): PdfRect {
  const rects: PdfRect[] = [];
  for (const segment of source.segments) {
    const overlapStart = Math.max(start, segment.start);
    const overlapEnd = Math.min(end, segment.end);
    if (overlapStart >= overlapEnd) continue;
    const length = Math.max(1, segment.end - segment.start);
    const from = (overlapStart - segment.start) / length;
    const to = (overlapEnd - segment.start) / length;
    rects.push({
      x: segment.run.rect.x + segment.run.rect.w * from,
      y: segment.run.rect.y,
      w: segment.run.rect.w * (to - from),
      h: segment.run.rect.h,
    });
  }
  return rects.length > 0 ? unionRects(rects) : source.line.rect;
}

function overlapsExisting(start: number, end: number, existing: readonly IndexedDetection[]): boolean {
  return existing.some((item) => start < item.end && end > item.start);
}

function addDetection(
  source: MappedLine,
  existing: IndexedDetection[],
  match: RegExpExecArray,
  value: Omit<DetectedDate, 'raw' | 'pageIndex' | 'rect' | 'contextText'>,
): void {
  const start = match.index;
  const end = start + match[0].length;
  if (overlapsExisting(start, end, existing)) return;
  existing.push({
    start,
    end,
    detected: {
      ...value,
      raw: match[0],
      pageIndex: source.line.pageIndex,
      rect: matchRect(source, start, end),
      contextText: source.text,
    },
  });
}

function dateOrder(left: string, right: string): number {
  return left.localeCompare(right);
}

function detectNamedRanges(source: MappedLine, found: IndexedDetection[]): void {
  const expression = new RegExp(
    `\\b${NAMED_DATE_PATTERN}\\s*(?:-|–|—|to)\\s*${NAMED_DATE_PATTERN}\\b`,
    'gi',
  );
  for (let match = expression.exec(source.text); match; match = expression.exec(source.text)) {
    const firstMonth = MONTHS.get((match[2] ?? '').toLowerCase());
    const secondMonth = MONTHS.get((match[5] ?? '').toLowerCase());
    if (!firstMonth || !secondMonth) continue;
    const explicitFirstYear = match[3];
    const explicitSecondYear = match[6];
    const firstYear = normalizeYear(explicitFirstYear ?? explicitSecondYear);
    let secondYear = normalizeYear(explicitSecondYear ?? explicitFirstYear);
    const startISO = isoDate(firstYear, firstMonth, Number(match[1]));
    let endISO = isoDate(secondYear, secondMonth, Number(match[4]));
    if (startISO && endISO && dateOrder(endISO, startISO) < 0 && !explicitSecondYear) {
      secondYear += 1;
      endISO = isoDate(secondYear, secondMonth, Number(match[4]));
    }
    if (!startISO || !endISO) continue;
    addDetection(source, found, match, { startISO, endISO, allDay: true });
  }
}

function detectNumericRanges(source: MappedLine, found: IndexedDetection[]): void {
  const expression = new RegExp(
    `\\b${NUMERIC_DATE_PATTERN}\\s*(?:-|–|—|to)\\s*${NUMERIC_DATE_PATTERN}\\b`,
    'g',
  );
  for (let match = expression.exec(source.text); match; match = expression.exec(source.text)) {
    const startISO = isoDate(normalizeYear(match[3]), Number(match[2]), Number(match[1]));
    const endISO = isoDate(normalizeYear(match[6]), Number(match[5]), Number(match[4]));
    if (!startISO || !endISO) continue;
    const altStart = Number(match[1]) <= 12 && Number(match[2]) <= 12
      ? isoDate(normalizeYear(match[3]), Number(match[1]), Number(match[2]))
      : undefined;
    const altEnd = Number(match[4]) <= 12 && Number(match[5]) <= 12
      ? isoDate(normalizeYear(match[6]), Number(match[4]), Number(match[5]))
      : undefined;
    addDetection(source, found, match, {
      startISO,
      endISO,
      allDay: true,
      monthDayStartISO: altStart,
      monthDayEndISO: altStart && altEnd ? altEnd : undefined,
    });
  }
}

function detectNamedDates(source: MappedLine, found: IndexedDetection[]): void {
  const expression = new RegExp(`\\b${NAMED_DATE_PATTERN}\\b`, 'gi');
  for (let match = expression.exec(source.text); match; match = expression.exec(source.text)) {
    const month = MONTHS.get((match[2] ?? '').toLowerCase());
    if (!month) continue;
    const startISO = isoDate(normalizeYear(match[3]), month, Number(match[1]));
    if (!startISO) continue;
    addDetection(source, found, match, { startISO, allDay: true });
  }
}

function detectNumericDates(source: MappedLine, found: IndexedDetection[]): void {
  const expression = new RegExp(`\\b${NUMERIC_DATE_PATTERN}\\b`, 'g');
  for (let match = expression.exec(source.text); match; match = expression.exec(source.text)) {
    const year = normalizeYear(match[3]);
    const day = Number(match[1]);
    const month = Number(match[2]);
    const dayMonth = isoDate(year, month, day);
    const monthDay = day <= 12 && month <= 12 ? isoDate(year, day, month) : undefined;
    const startISO = dayMonth ?? monthDay;
    if (!startISO) continue;
    addDetection(source, found, match, {
      startISO,
      allDay: true,
      monthDayStartISO: dayMonth && monthDay && dayMonth !== monthDay ? monthDay : undefined,
    });
  }
}

function todayISO(): string {
  const now = new Date();
  return isoDate(now.getFullYear(), now.getMonth() + 1, now.getDate()) ?? '1970-01-01';
}

function detectTimes(source: MappedLine, found: IndexedDetection[]): void {
  const expression = /\b(?:([01]?\d|2[0-3]):([0-5]\d)|([1-9]|1[0-2])\s*(am|pm))\b/gi;
  for (let match = expression.exec(source.text); match; match = expression.exec(source.text)) {
    if (overlapsExisting(match.index, match.index + match[0].length, found)) continue;
    let hour = match[1] === undefined ? Number(match[3]) : Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    const meridiem = match[4]?.toLowerCase();
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (meridiem === 'pm' && hour !== 12) hour += 12;

    const nearestDate = found
      .filter((item) => item.detected.allDay)
      .sort((left, right) => (
        Math.abs((left.start + left.end) / 2 - match.index) -
        Math.abs((right.start + right.end) / 2 - match.index)
      ))[0];
    const date = nearestDate?.detected.startISO.slice(0, 10) ?? todayISO();
    addDetection(source, found, match, {
      startISO: `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`,
      allDay: false,
    });
  }
}

/** Detect calendar-able dates and times and map every match back into PDF-point geometry. */
export function detectDates(runs: readonly TextRun[]): DetectedDate[] {
  const result: IndexedDetection[] = [];
  for (const line of mergeRunsIntoLines(runs).map(mappedLine)) {
    const found: IndexedDetection[] = [];
    detectNamedRanges(line, found);
    detectNumericRanges(line, found);
    detectNamedDates(line, found);
    detectNumericDates(line, found);
    detectTimes(line, found);
    result.push(...found);
  }
  return result
    .sort((left, right) => (
      left.detected.pageIndex - right.detected.pageIndex ||
      right.detected.rect.y - left.detected.rect.y ||
      left.detected.rect.x - right.detected.rect.x
    ))
    .map((item) => item.detected);
}
