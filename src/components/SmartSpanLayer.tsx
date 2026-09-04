import { useState } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import { pdfRectToScreenRect } from '@/lib/export/coordinates';
import type { DetectedDate } from '@/lib/smart/dateDetect';
import type { DetectedLocation } from '@/lib/smart/locationDetect';
import { DateActionPopover } from './DateActionPopover';
import { LocationActionPopover } from './LocationActionPopover';

interface SmartSpanLayerProps {
  readonly dates: readonly DetectedDate[];
  readonly locations: readonly DetectedLocation[];
  readonly viewport: PageViewport;
  readonly dpr: number;
}

const LOCATION_UNDERLINE_COLOR = '#0F6E56';
const LOCATION_UNDERLINE_OFFSET = 2;

export function SmartSpanLayer({ dates, locations, viewport, dpr }: SmartSpanLayerProps) {
  const [selectedDate, setSelectedDate] = useState<DetectedDate | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<DetectedLocation | null>(null);
  const selectedDateRect = selectedDate
    ? pdfRectToScreenRect(selectedDate.rect, viewport, dpr)
    : null;
  const selectedLocationRect = selectedLocation
    ? pdfRectToScreenRect(selectedLocation.rect, viewport, dpr)
    : null;

  return (
    <>
      {dates.map((date) => {
        const rect = pdfRectToScreenRect(date.rect, viewport, dpr);
        return (
          <button
            key={`${date.pageIndex}:${date.rect.x}:${date.rect.y}:${date.raw}`}
            type="button"
            aria-label={`Date actions: ${date.raw}`}
            title={`${date.raw} — calendar actions`}
            onClick={() => {
              setSelectedLocation(null);
              setSelectedDate(date);
            }}
            className="absolute z-[15] cursor-pointer border-0 border-b-2 border-dotted border-amber-600 bg-amber-200/10 p-0 hover:bg-amber-200/25 focus:bg-amber-200/25 focus:outline-none focus:ring-2 focus:ring-amber-500/70"
            style={{
              left: rect.left,
              top: rect.top,
              width: Math.max(2, rect.width),
              height: Math.max(4, rect.height),
            }}
          />
        );
      })}

      {locations.map((location) => {
        const rect = pdfRectToScreenRect(location.rect, viewport, dpr);
        return (
          <button
            key={`${location.pageIndex}:${location.rect.x}:${location.rect.y}:${location.text}`}
            type="button"
            aria-label={`Location actions: ${location.text}`}
            title={`${location.text} — location actions`}
            onClick={() => {
              setSelectedDate(null);
              setSelectedLocation(location);
            }}
            data-location-underline="true"
            className="absolute z-[15] cursor-pointer border-0 bg-transparent p-0 focus:outline-none focus:ring-2 focus:ring-emerald-700/40"
            style={{
              left: rect.left,
              top: rect.top,
              width: Math.max(2, rect.width),
              height: Math.max(4, rect.height),
            }}
          >
            <span
              data-testid="location-underline"
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 h-px"
              style={{
                bottom: -LOCATION_UNDERLINE_OFFSET,
                backgroundColor: LOCATION_UNDERLINE_COLOR,
              }}
            />
          </button>
        );
      })}

      {selectedDate && selectedDateRect && (
        <DateActionPopover
          key={`${selectedDate.pageIndex}:${selectedDate.rect.x}:${selectedDate.rect.y}:${selectedDate.raw}`}
          detected={selectedDate}
          screenRect={selectedDateRect}
          pageWidth={viewport.width / dpr}
          onClose={() => setSelectedDate(null)}
        />
      )}

      {selectedLocation && selectedLocationRect && (
        <LocationActionPopover
          key={`${selectedLocation.pageIndex}:${selectedLocation.rect.x}:${selectedLocation.rect.y}:${selectedLocation.text}`}
          detected={selectedLocation}
          screenRect={selectedLocationRect}
          pageWidth={viewport.width / dpr}
          onClose={() => setSelectedLocation(null)}
        />
      )}
    </>
  );
}
