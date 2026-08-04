import { describe, expect, it } from 'vitest';
import { googleCalendarUrl, googleDateSearchUrl } from './calendarLink';

describe('googleCalendarUrl', () => {
  it('encodes an all-day itinerary range with an exclusive Google end date', () => {
    const url = new URL(googleCalendarUrl({
      title: '  Bali   travel  ',
      startISO: '2026-08-12',
      endISO: '2026-08-23',
      allDay: true,
      details: 'From the itinerary',
    }));

    expect(url.origin).toBe('https://calendar.google.com');
    expect(url.pathname).toBe('/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Bali travel');
    expect(url.searchParams.get('dates')).toBe('20260812/20260824');
    expect(url.searchParams.get('details')).toBe('From the itinerary');
  });

  it('uses a one-hour default for a timed event and emits UTC timestamps', () => {
    const url = new URL(googleCalendarUrl({
      title: 'Sunrise pickup',
      startISO: '2026-08-12T15:00:00Z',
      allDay: false,
    }));

    expect(url.searchParams.get('dates')).toBe('20260812T150000Z/20260812T160000Z');
  });

  it('rejects an empty event title', () => {
    expect(() => googleCalendarUrl({
      title: '  ',
      startISO: '2026-08-12',
      allDay: true,
    })).toThrow('title');
  });
});

describe('googleDateSearchUrl', () => {
  it('searches only the normalized confirmed title and raw date', () => {
    const url = new URL(googleDateSearchUrl('  Mount Batur  sunrise ', '  12 Aug 2026 '));
    expect(url.origin).toBe('https://www.google.com');
    expect(url.searchParams.get('q')).toBe('Mount Batur sunrise 12 Aug 2026');
    expect(url.searchParams.size).toBe(1);
  });
});
