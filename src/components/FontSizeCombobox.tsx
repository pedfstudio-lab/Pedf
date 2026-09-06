import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FONT_SIZE_PRESETS,
  formatFontSize,
  parseFontSizeInput,
} from '@/lib/edit/fontSize';

interface FontSizeComboboxProps {
  readonly value: number;
  onApply(pt: number): void;
}

export function FontSizeCombobox({ value, onApply }: FontSizeComboboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const applyingRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => formatFontSize(value));

  useEffect(() => {
    setDraft(formatFontSize(value));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.document.addEventListener('pointerdown', closeOutside);
    return () => window.document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  const apply = useCallback((raw: string) => {
    if (applyingRef.current) return;
    const parsed = parseFontSizeInput(raw);
    setOpen(false);
    if (parsed === undefined) {
      setDraft(formatFontSize(value));
      return;
    }
    setDraft(formatFontSize(parsed));
    applyingRef.current = true;
    try {
      onApply(parsed);
    } finally {
      window.queueMicrotask(() => { applyingRef.current = false; });
    }
  }, [onApply, value]);

  return (
    <div ref={rootRef} className="relative flex items-stretch">
      <input
        type="text"
        role="combobox"
        aria-label="Font size"
        aria-expanded={open}
        aria-controls="font-size-options"
        aria-autocomplete="list"
        inputMode="decimal"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setOpen(false)}
        onBlur={() => {
          if (!applyingRef.current) apply(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            apply(draft);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(formatFontSize(value));
            setOpen(false);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="w-[3.5em] rounded-l border border-neutral-200 bg-white px-1 py-1 text-right text-sm outline-none focus:border-blue-500"
      />
      <button
        type="button"
        aria-label="Choose font size"
        aria-expanded={open}
        aria-controls="font-size-options"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
        className="rounded-r border border-l-0 border-neutral-200 bg-white px-1.5 text-xs hover:bg-neutral-100"
      >
        ▾
      </button>
      {open && (
        <ul
          id="font-size-options"
          role="listbox"
          aria-label="Font size presets"
          className="absolute left-0 top-full z-50 mt-1 max-h-52 min-w-full overflow-y-auto rounded border border-neutral-300 bg-white p-1 shadow-lg"
        >
          {FONT_SIZE_PRESETS.map((preset) => (
            <li key={preset} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={preset === value}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => apply(String(preset))}
                className="block w-full rounded px-2 py-1 text-right text-sm hover:bg-neutral-100 aria-selected:bg-blue-100 aria-selected:text-blue-800"
              >
                {preset}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
