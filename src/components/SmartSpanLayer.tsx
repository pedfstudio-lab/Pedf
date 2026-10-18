import { useEffect, useState } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import { pdfRectToScreenRect } from '@/lib/export/coordinates';
import type { DetectedDate } from '@/lib/smart/dateDetect';
import { DateActionPopover } from './DateActionPopover';

interface SmartSpanLayerProps {
  readonly dates: readonly DetectedDate[];
  readonly viewport: PageViewport;
  readonly dpr: number;
  readonly closeSelectionKey?: number;
  onOpenPopover?(): void;
}

export function SmartSpanLayer({
  dates,
  viewport,
  dpr,
  closeSelectionKey,
  onOpenPopover,
}: SmartSpanLayerProps) {
  const [selectedDate, setSelectedDate] = useState<DetectedDate | null>(null);
  const [selectionKey, setSelectionKey] = useState(closeSelectionKey);
  useEffect(() => {
    setSelectedDate(null);
    setSelectionKey(closeSelectionKey);
  }, [closeSelectionKey]);
  const selectionVisible = selectionKey === closeSelectionKey;
  const selectedDateRect = selectionVisible && selectedDate
    ? pdfRectToScreenRect(selectedDate.rect, viewport, dpr)
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
              onOpenPopover?.();
              setSelectionKey(closeSelectionKey);
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

      {selectedDate && selectedDateRect && (
        <DateActionPopover
          key={`${selectedDate.pageIndex}:${selectedDate.rect.x}:${selectedDate.rect.y}:${selectedDate.raw}`}
          detected={selectedDate}
          screenRect={selectedDateRect}
          pageWidth={viewport.width / dpr}
          onClose={() => setSelectedDate(null)}
        />
      )}
    </>
  );
}
