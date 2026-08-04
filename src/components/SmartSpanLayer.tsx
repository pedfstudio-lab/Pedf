import { useState } from 'react';
import type { PageViewport } from 'pdfjs-dist';
import { pdfRectToScreenRect } from '@/lib/export/coordinates';
import type { DetectedDate } from '@/lib/smart/dateDetect';
import { DateActionPopover } from './DateActionPopover';

interface SmartSpanLayerProps {
  readonly dates: readonly DetectedDate[];
  readonly viewport: PageViewport;
  readonly dpr: number;
}

export function SmartSpanLayer({ dates, viewport, dpr }: SmartSpanLayerProps) {
  const [selected, setSelected] = useState<DetectedDate | null>(null);
  const selectedRect = selected ? pdfRectToScreenRect(selected.rect, viewport, dpr) : null;

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
            onClick={() => setSelected(date)}
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

      {selected && selectedRect && (
        <DateActionPopover
          key={`${selected.pageIndex}:${selected.rect.x}:${selected.rect.y}:${selected.raw}`}
          detected={selected}
          screenRect={selectedRect}
          pageWidth={viewport.width / dpr}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
