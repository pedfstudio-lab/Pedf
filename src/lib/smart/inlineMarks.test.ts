import { describe, expect, it } from 'vitest';
import type { TextSpan } from '@/lib/export/types';
import type { DetectedDate } from './dateDetect';
import { markInlineSmartSegments, markLocationsInLine } from './inlineMarks';

function marked(segments: ReturnType<typeof markLocationsInLine>) {
  return segments
    .filter((segment) => segment.location)
    .map((segment) => [segment.text, segment.location]);
}

describe('markLocationsInLine', () => {
  it('marks two place names in a plain line', () => {
    expect(marked(markLocationsInLine(
      'Travel from Morjim to North Goa.',
      undefined,
      ['Morjim', 'North Goa'],
    ))).toEqual([
      ['Morjim', 'Morjim'],
      ['North Goa', 'North Goa'],
    ]);
  });

  it('keeps one continuous location identity when the name crosses a rich-text boundary', () => {
    const spans: TextSpan[] = [
      { text: 'North ', bold: false, italic: false },
      { text: 'Goa', bold: true, italic: false },
      { text: "'s beaches", bold: false, italic: false },
    ];

    const matches = markLocationsInLine("North Goa's beaches", spans, ['North Goa'])
      .filter((segment) => segment.location);

    expect(matches.map((segment) => segment.text).join('')).toBe('North Goa');
    expect(matches.every((segment) => segment.location === 'North Goa')).toBe(true);
    expect(matches.map((segment) => segment.span?.bold)).toEqual([false, true]);
  });

  it('matches whole words only', () => {
    expect(marked(markLocationsInLine('Goal Goa Goat', undefined, ['Goa']))).toEqual([
      ['Goa', 'Goa'],
    ]);
  });

  it('prefers the longest location name', () => {
    expect(marked(markLocationsInLine('North Goa', undefined, ['Goa', 'North Goa']))).toEqual([
      ['North Goa', 'North Goa'],
    ]);
  });

  it('returns one plain segment when there are no names', () => {
    expect(markLocationsInLine('No place here', undefined, [])).toEqual([
      { text: 'No place here' },
    ]);
  });

  it('marks a detected date while preserving the rest of the edited line', () => {
    const date: DetectedDate = {
      raw: '23 September 2026',
      startISO: '2026-09-23',
      allDay: true,
      pageIndex: 0,
      rect: { x: 20, y: 40, w: 100, h: 12 },
      contextText: 'Arrive on 23 September 2026 in Ziro.',
    };

    const segments = markInlineSmartSegments(
      'Arrive on 23 September 2026 in Ziro.',
      undefined,
      ['Ziro'],
      [date],
    );

    expect(segments.find((segment) => segment.date)?.text).toBe('23 September 2026');
    expect(segments.find((segment) => segment.location)?.text).toBe('Ziro');
    expect(segments.map((segment) => segment.text).join('')).toBe(
      'Arrive on 23 September 2026 in Ziro.',
    );
  });
});
