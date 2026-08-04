import { useEffect, useMemo, useRef } from 'react';
import type { ScreenRect } from '@/lib/export/coordinates';

interface TapPopoverProps {
  readonly text: string;
  readonly screenRect: ScreenRect;
  readonly pageWidth: number;
  onEdit(): void;
  onClose(): void;
}

const MENU_WIDTH = 224;
const MENU_HEIGHT_ESTIMATE = 184;
const EDGE_GAP = 8;

export function TapPopover({
  text,
  screenRect,
  pageWidth,
  onEdit,
  onClose,
}: TapPopoverProps) {
  const editRef = useRef<HTMLButtonElement>(null);
  const label = useMemo(() => text.replace(/\s+/g, ' ').trim().slice(0, 80), [text]);
  const placeAbove = screenRect.top >= MENU_HEIGHT_ESTIMATE + EDGE_GAP;
  const left = Math.min(
    Math.max(EDGE_GAP, screenRect.left),
    Math.max(EDGE_GAP, pageWidth - MENU_WIDTH - EDGE_GAP),
  );
  const top = placeAbove
    ? screenRect.top - EDGE_GAP
    : screenRect.top + screenRect.height + EDGE_GAP;

  useEffect(() => {
    editRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.document.addEventListener('keydown', closeOnEscape);
    return () => window.document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        aria-label="Close text actions"
        onClick={onClose}
        className="absolute inset-0 z-40 cursor-default bg-transparent"
      />
      <div
        role="dialog"
        aria-label={`Text actions: ${label}`}
        className="absolute z-50 w-56 rounded-xl border border-neutral-200 bg-white p-2 text-neutral-900 shadow-2xl"
        style={{
          left,
          top,
          transform: placeAbove ? 'translateY(-100%)' : undefined,
        }}
      >
        <p className="mb-2 truncate px-2 text-xs font-medium text-neutral-500" title={label}>
          {label || 'Selected text'}
        </p>
        <div className="grid gap-1" role="menu">
          <button
            ref={editRef}
            type="button"
            role="menuitem"
            onClick={onEdit}
            className="rounded-lg px-3 py-2 text-left text-sm font-medium hover:bg-neutral-100 focus:bg-neutral-100 focus:outline-none"
          >
            Edit
          </button>
          <div className="my-1 h-px bg-neutral-200" />
          <button
            type="button"
            role="menuitem"
            disabled
            title="Available in the translation update"
            className="cursor-not-allowed rounded-lg px-3 py-2 text-left text-sm text-neutral-400"
          >
            Translate
          </button>
          <button
            type="button"
            role="menuitem"
            disabled
            title="Available in the translation update"
            className="cursor-not-allowed rounded-lg px-3 py-2 text-left text-sm text-neutral-400"
          >
            Meaning
          </button>
        </div>
      </div>
    </>
  );
}
