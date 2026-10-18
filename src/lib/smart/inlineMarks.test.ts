import { describe, expect, it } from 'vitest';
import type { TextSpan } from '@/lib/export/types';
import type { DetectedDate } from './dateDetect';
import { markInlineSmartSegments } from './inlineMarks';

const date: DetectedDate = {
  raw: '23 September 2026',
  startISO: '2026-09-23',
  allDay: true,
  pageIndex: 0,
  rect: { x: 20, y: 40, w: 100, h: 12 },
  contextText: 'Arrive on 23 September 2026 in Ziro.',
};

describe('markInlineSmartSegments', () => {
  it('returns one plain segment when there are no dates', () => {
    expect(markInlineSmartSegments('No date here', undefined, [])).toEqual([
      { text: 'No date here' },
    ]);
  });

  it('marks a detected date while preserving the rest of the edited line', () => {
    const segments = markInlineSmartSegments('Arrive on 23 September 2026 in Ziro.', undefined, [date]);

    expect(segments.find((segment) => segment.date)?.text).toBe('23 September 2026');
    expect(segments.map((segment) => segment.text).join('')).toBe('Arrive on 23 September 2026 in Ziro.');
    expect(segments.filter((segment) => segment.date)).toHaveLength(1);
  });

  it('keeps rich-text styles on both sides of a date', () => {
    const spans: TextSpan[] = [
      { text: 'Arrive on ', bold: true, italic: false },
      { text: '23 September 2026 in Ziro.', bold: false, italic: false },
    ];
    const segments = markInlineSmartSegments('Arrive on 23 September 2026 in Ziro.', spans, [date]);

    expect(segments.map((segment) => [segment.text, segment.span?.bold, Boolean(segment.date)])).toEqual([
      ['Arrive on ', true, false],
      ['23 September 2026', false, true],
      [' in Ziro.', false, false],
    ]);
  });

  it('matches whole words only', () => {
    const segments = markInlineSmartSegments('X23 September 2026', undefined, [date]);
    expect(segments.some((segment) => segment.date)).toBe(false);
  });
});
