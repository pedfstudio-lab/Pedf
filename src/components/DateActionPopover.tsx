import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ScreenRect } from '@/lib/export/coordinates';
import type { DetectedDate } from '@/lib/smart/dateDetect';
import { googleCalendarUrl, googleDateSearchUrl } from '@/lib/smart/calendarLink';

interface DateActionPopoverProps {
  readonly detected: DetectedDate;
  readonly screenRect: ScreenRect;
  readonly pageWidth: number;
  onClose(): void;
}

type DateOrder = 'day-month' | 'month-day';

const MENU_WIDTH = 304;
const MENU_HEIGHT_ESTIMATE = 390;
const EDGE_GAP = 8;

function defaultTitle(detected: DetectedDate): string {
  const nearby = detected.contextText
    .replace(detected.raw, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,–—-]+|[\s:;,–—-]+$/g, '')
    .trim();
  return nearby ? nearby.slice(0, 80) : `Travel: ${detected.raw}`;
}

function dateValue(iso: string, allDay: boolean): Date {
  return new Date(allDay ? `${iso}T00:00:00Z` : iso);
}

function readableDate(iso: string, allDay: boolean): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(allDay ? {} : { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }),
    timeZone: 'UTC',
  }).format(dateValue(iso, allDay));
}

export function DateActionPopover({
  detected,
  screenRect,
  pageWidth,
  onClose,
}: DateActionPopoverProps) {
  const titleId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(() => defaultTitle(detected));
  const [dateOrder, setDateOrder] = useState<DateOrder>('day-month');
  const canUseMonthDay = Boolean(detected.monthDayStartISO);
  const startISO = dateOrder === 'month-day'
    ? detected.monthDayStartISO ?? detected.startISO
    : detected.startISO;
  const endISO = dateOrder === 'month-day'
    ? detected.monthDayEndISO ?? detected.endISO
    : detected.endISO;
  const readable = useMemo(() => {
    const start = readableDate(startISO, detected.allDay);
    return endISO ? `${start} – ${readableDate(endISO, detected.allDay)}` : start;
  }, [detected.allDay, endISO, startISO]);
  const placeAbove = screenRect.top >= MENU_HEIGHT_ESTIMATE + EDGE_GAP;
  const left = Math.min(
    Math.max(EDGE_GAP, screenRect.left),
    Math.max(EDGE_GAP, pageWidth - MENU_WIDTH - EDGE_GAP),
  );
  const top = placeAbove
    ? screenRect.top - EDGE_GAP
    : screenRect.top + screenRect.height + EDGE_GAP;
  const event = {
    title,
    startISO,
    endISO,
    allDay: detected.allDay,
    details: `Detected from the PDF: ${detected.raw}`,
  };

  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
    const closeOnEscape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') onClose();
    };
    window.document.addEventListener('keydown', closeOnEscape);
    return () => window.document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const open = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
    onClose();
  };
  const openCalendar = () => {
    if (!title.trim()) return;
    open(googleCalendarUrl(event));
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close date actions"
        onClick={onClose}
        className="absolute inset-0 z-[55] cursor-default bg-transparent"
      />
      <div
        role="dialog"
        aria-label={`Date actions: ${detected.raw}`}
        className="absolute z-[60] w-[19rem] rounded-xl border border-neutral-200 bg-white p-3 text-neutral-900 shadow-2xl"
        style={{
          left,
          top,
          transform: placeAbove ? 'translateY(-100%)' : undefined,
        }}
      >
        <div className="mb-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Date or time</p>
          <p className="mt-1 text-sm font-medium" data-testid="parsed-date">{readable}</p>
          <p className="mt-0.5 truncate text-xs text-neutral-500" title={detected.raw}>{detected.raw}</p>
        </div>

        <label className="block text-xs font-medium text-neutral-600" htmlFor={titleId}>
          Event title
        </label>
        <input
          ref={titleRef}
          id={titleId}
          value={title}
          onChange={(eventTarget) => setTitle(eventTarget.target.value)}
          className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200"
        />

        {canUseMonthDay && (
          <label className="mt-3 block text-xs font-medium text-neutral-600">
            Date interpretation
            <select
              aria-label="Date interpretation"
              value={dateOrder}
              onChange={(eventTarget) => setDateOrder(eventTarget.target.value as DateOrder)}
              className="mt-1 block w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm"
            >
              <option value="day-month">Day / month (India)</option>
              <option value="month-day">Month / day</option>
            </select>
          </label>
        )}

        <div className="mt-3 grid gap-1" role="menu">
          <button
            type="button"
            role="menuitem"
            disabled={!title.trim()}
            onClick={openCalendar}
            className="rounded-lg bg-neutral-900 px-3 py-2 text-left text-sm font-semibold text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
          >
            Add to Google Calendar
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!title.trim()}
            onClick={openCalendar}
            className="rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400"
            title="Uses your Google Calendar default reminder"
          >
            Set Reminder
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!title.trim()}
            onClick={() => open(googleDateSearchUrl(title, detected.raw))}
            className="rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400"
          >
            Search Google
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-left text-sm text-neutral-500 hover:bg-neutral-100"
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
