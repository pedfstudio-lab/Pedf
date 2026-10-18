import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScreenRect } from '@/lib/export/coordinates';
import { useTranslation } from '@/state/translationStore';
import { SUPPORTED_LANGUAGES } from '@/state/prefsStore';
import { scriptFonts, translationError } from '@/lib/translate/pageTranslation';

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
  const translation = useTranslation();
  const [card, setCard] = useState(false);
  const [language, setLanguage] = useState(() => {
    const preferred = translation?.language !== 'en-IN' ? translation?.language : translation?.preferredLanguage;
    return preferred && preferred !== 'en-IN' ? preferred : '';
  });
  const [result, setResult] = useState<{ text?: string; error?: string }>();
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!card || !language || !translation) return;
    const abort = new AbortController();
    setResult(undefined); setCopied(false); translation.notePrivacy();
    void translation.cache.translate([{ id: 'selection', text }], language, translation.provider, abort.signal)
      .then(translated => { if (!abort.signal.aborted) setResult({ text: translated.get('selection') }); })
      .catch(error => { if (!abort.signal.aborted) setResult({ error: translationError(error) }); });
    return () => abort.abort();
    // The per-document cache/provider are stable; unrelated toolbar state is not a request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card, language, text, retry, translation?.cache, translation?.provider]);
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
        {card ? <div className="grid gap-2 px-1" aria-label="Selected text translation">
          <label className="text-xs text-neutral-600">Read in
            <select aria-label="Translation language" value={language} onChange={event => setLanguage(event.target.value)} className="mt-1 w-full rounded border border-neutral-300 bg-white p-2 text-sm">
              <option value="">Choose a language</option>
              {SUPPORTED_LANGUAGES.filter(item => item.code !== 'en-IN').map(item => <option key={item.code} value={item.code}>{item.label} · {item.name}</option>)}
            </select>
          </label>
          {language && <p role="status" lang={language} className="max-h-56 overflow-auto whitespace-pre-wrap text-sm" style={{ fontFamily: scriptFonts[language] }}>
            {result?.text ?? result?.error ?? 'Translating…'}
          </p>}
          {result?.error && <button type="button" onClick={() => setRetry(value => value + 1)} className="text-left text-xs text-indigo-700 underline">Try again</button>}
          <div className="flex items-center justify-between">
            <button type="button" onClick={() => setCard(false)} className="rounded px-2 py-1 text-xs hover:bg-neutral-100">Back</button>
            <button type="button" disabled={!result?.text} onClick={() => {
              if (result?.text) void navigator.clipboard.writeText(result.text).then(() => setCopied(true)).catch(() => setCopied(false));
            }} className="rounded bg-indigo-600 px-3 py-1 text-xs text-white disabled:opacity-40">{copied ? 'Copied' : 'Copy'}</button>
          </div>
        </div> : <div className="grid gap-1" role="menu">
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
            onClick={() => setCard(true)}
            className="rounded-lg px-3 py-2 text-left text-sm hover:bg-neutral-100"
          >
            Translate
          </button>
        </div>}
      </div>
    </>
  );
}
