import { describe, expect, it } from 'vitest';
import type { TextRun } from '@/lib/pdf/textContent';
import { detectDates } from './dateDetect';

const style = {
  fontName: 'Helvetica',
  fontSizePt: 10,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
};

function run(text: string, x = 10, y = 500, w = text.length * 5): TextRun {
  return { pageIndex: 0, text, rect: { x, y, w, h: 10 }, style };
}

describe('detectDates', () => {
  it('detects a named itinerary range as one positioned all-day span', () => {
    const [date] = detectDates([run('Travel dates: 12 Aug 2026 - 23 Aug 2026')]);

    expect(date).toMatchObject({
      raw: '12 Aug 2026 - 23 Aug 2026',
      startISO: '2026-08-12',
      endISO: '2026-08-23',
      allDay: true,
      pageIndex: 0,
    });
    expect(date?.rect.x).toBeGreaterThan(10);
    expect(date?.rect.w).toBeLessThan('Travel dates: 12 Aug 2026 - 23 Aug 2026'.length * 5);
  });

  it('uses Indian day-month order and exposes an alternate for ambiguous numeric dates', () => {
    const dates = detectDates([
      run('Depart 12/08/2026', 10, 500),
      run('Return 03/04/2026', 10, 480),
    ]);

    expect(dates[0]).toMatchObject({ startISO: '2026-08-12' });
    expect(dates[1]).toMatchObject({
      startISO: '2026-04-03',
      monthDayStartISO: '2026-03-04',
    });
  });

  it('detects a yearless named date using the current year', () => {
    const [date] = detectDates([run('Meet on 15 Aug')]);
    expect(date?.startISO).toBe(`${new Date().getFullYear()}-08-15`);
  });

  it('detects 12-hour and 24-hour clocks and binds them to a nearby date', () => {
    const dates = detectDates([run('12 Aug 2026 at 3pm and 14:30')]);

    expect(dates.map((date) => [date.raw, date.startISO, date.allDay])).toEqual([
      ['12 Aug 2026', '2026-08-12', true],
      ['3pm', '2026-08-12T15:00:00Z', false],
      ['14:30', '2026-08-12T14:30:00Z', false],
    ]);
  });

  it('unions geometry when a date range spans multiple PDF runs', () => {
    const [date] = detectDates([
      run('12 Aug 2026', 10, 500, 55),
      run('-', 67, 500, 3),
      run('23 Aug 2026', 72, 500, 55),
    ]);

    expect(date?.raw).toBe('12 Aug 2026 - 23 Aug 2026');
    expect(date?.rect).toEqual({ x: 10, y: 500, w: 117, h: 10 });
  });

  it('ignores durations that are not calendar dates or clock times', () => {
    expect(detectDates([run('90 Mins · 11 Nights · 2 Adults')])).toEqual([]);
  });
});
