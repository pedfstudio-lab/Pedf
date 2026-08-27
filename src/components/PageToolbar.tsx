import { useEdits } from '@/state/editsStore';

interface PageToolbarProps {
  readonly position: number;
  readonly widthPt: number;
  readonly heightPt: number;
}

export function PageToolbar({ position, widthPt, heightPt }: PageToolbarProps) {
  const { deletePage, duplicatePage, insertBlankPage, pagePlan } = useEdits();
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white/95 px-2 py-1 text-xs text-neutral-600 shadow-sm"
      aria-label={`Page ${position + 1} operations`}
    >
      <span className="font-semibold text-neutral-500">Page {position + 1}</span>
      <button
        type="button"
        onClick={() => duplicatePage(position)}
        className="rounded px-2 py-1 font-medium text-neutral-700 hover:bg-neutral-100"
      >
        Duplicate Page
      </button>
      <button
        type="button"
        onClick={() => insertBlankPage(position, { widthPt, heightPt })}
        className="rounded px-2 py-1 font-medium text-neutral-700 hover:bg-neutral-100"
      >
        Insert Page
      </button>
      <button
        type="button"
        onClick={() => deletePage(position)}
        disabled={pagePlan.length <= 1}
        aria-label="Delete Page"
        title="Delete page"
        className="rounded px-2 py-1 font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 11v5M14 11v5" />
        </svg>
      </button>
    </div>
  );
}
