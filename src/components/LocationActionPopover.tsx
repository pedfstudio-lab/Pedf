import { useEffect } from 'react';
import type { ScreenRect } from '@/lib/export/coordinates';
import type { DetectedLocation } from '@/lib/smart/locationDetect';
import { googleLocationSearchUrl, googleMapsLocationUrl } from '@/lib/smart/locationLink';

interface LocationActionPopoverProps {
  readonly detected: DetectedLocation;
  readonly screenRect: ScreenRect;
  readonly pageWidth: number;
  onClose(): void;
}

const MENU_WIDTH = 256;
const MENU_HEIGHT_ESTIMATE = 150;
const EDGE_GAP = 8;

export function LocationActionPopover({
  detected,
  screenRect,
  pageWidth,
  onClose,
}: LocationActionPopoverProps) {
  const placeAbove = screenRect.top >= MENU_HEIGHT_ESTIMATE + EDGE_GAP;
  const left = Math.min(
    Math.max(EDGE_GAP, screenRect.left),
    Math.max(EDGE_GAP, pageWidth - MENU_WIDTH - EDGE_GAP),
  );
  const top = placeAbove
    ? screenRect.top - EDGE_GAP
    : screenRect.top + screenRect.height + EDGE_GAP;

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.document.addEventListener('keydown', closeOnEscape);
    return () => window.document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const open = (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
    onClose();
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close location actions"
        onClick={onClose}
        className="absolute inset-0 z-[55] cursor-default bg-transparent"
      />
      <div
        role="dialog"
        aria-label={`Location actions: ${detected.text}`}
        className="absolute z-[60] w-64 rounded-xl border border-neutral-200 bg-white p-3 text-neutral-900 shadow-2xl"
        style={{
          left,
          top,
          transform: placeAbove ? 'translateY(-100%)' : undefined,
        }}
      >
        <div className="mb-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Location</p>
          <p className="mt-1 truncate text-sm font-medium" title={detected.text}>{detected.text}</p>
        </div>
        <div className="grid gap-1" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => open(googleLocationSearchUrl(detected.text))}
            className="rounded-lg bg-neutral-900 px-3 py-2 text-left text-sm font-semibold text-white hover:bg-neutral-700"
          >
            Search Google
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => open(googleMapsLocationUrl(detected.text))}
            className="rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100"
          >
            Open in Google Maps
          </button>
        </div>
      </div>
    </>
  );
}
