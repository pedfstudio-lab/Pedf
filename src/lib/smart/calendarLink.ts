export interface CalendarEventLink {
  readonly title: string;
  readonly startISO: string;
  readonly endISO?: string;
  readonly allDay: boolean;
  readonly details?: string;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseDateOnly(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Expected an ISO date, received "${value}"`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new RangeError(`Invalid ISO date "${value}"`);
  }
  return date;
}

function compactDate(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('');
}

function compactTime(date: Date): string {
  return `${compactDate(date)}T${[
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
    String(date.getUTCSeconds()).padStart(2, '0'),
  ].join('')}Z`;
}

function parseTimed(value: string): Date {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const date = new Date(hasZone ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid ISO date/time "${value}"`);
  return date;
}

function calendarDates(event: CalendarEventLink): string {
  if (event.allDay) {
    const start = parseDateOnly(event.startISO);
    const inclusiveEnd = parseDateOnly(event.endISO ?? event.startISO);
    const exclusiveEnd = new Date(inclusiveEnd.getTime() + 86_400_000);
    return `${compactDate(start)}/${compactDate(exclusiveEnd)}`;
  }

  const start = parseTimed(event.startISO);
  const end = event.endISO
    ? parseTimed(event.endISO)
    : new Date(start.getTime() + 60 * 60 * 1000);
  return `${compactTime(start)}/${compactTime(end)}`;
}

/** Build a pre-filled Google Calendar event. All-day end dates are made exclusive for Google's API. */
export function googleCalendarUrl(event: CalendarEventLink): string {
  const title = normalizeText(event.title);
  if (!title) throw new RangeError('Calendar event title cannot be empty');
  const url = new URL('https://calendar.google.com/calendar/render');
  url.searchParams.set('action', 'TEMPLATE');
  url.searchParams.set('text', title);
  url.searchParams.set('dates', calendarDates(event));
  const details = normalizeText(event.details ?? '');
  if (details) url.searchParams.set('details', details);
  return url.toString();
}

/** Search only the confirmed event title and the tapped date/time text. */
export function googleDateSearchUrl(title: string, rawDate: string): string {
  const query = normalizeText(`${title} ${rawDate}`);
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  return url.toString();
}
