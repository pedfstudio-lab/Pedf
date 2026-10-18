import { useEffect, useRef, useState } from 'react';
import { SUPPORTED_LANGUAGES } from '@/state/prefsStore';
import { useTranslation } from '@/state/translationStore';
import { TRANSLATION_PRIVACY } from '@/lib/translate/pageTranslation';

export function TranslationControls({ disabled, onTranslate }: { readonly disabled: boolean; onTranslate?(): void }) {
  const translation = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setDraft(Boolean(document.querySelector('[contenteditable="true"]')));
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, [open]);
  if (!translation) return null;
  const current = SUPPORTED_LANGUAGES.find(item => item.code === translation.language)!;
  return <div ref={root} className="relative">
    <button type="button" disabled={disabled} aria-expanded={open} aria-haspopup="menu"
      onClick={() => setOpen(value => !value)}
      className={`whitespace-nowrap rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-40 ${translation.language !== 'en-IN' ? 'border-indigo-500 bg-indigo-50 text-indigo-800' : 'border-neutral-300 bg-white text-neutral-700'}`}>
      {translation.language === 'en-IN' ? 'Translate' : `Translate: ${current.name}`} ▾
    </button>
    {open && <div role="menu" aria-label="Read in your language" className="absolute right-0 z-[200] mt-2 w-60 rounded-xl border border-neutral-200 bg-white p-2 shadow-xl">
      <p className="px-2 py-1 text-xs text-neutral-500">On screen only · Export stays English</p>
      {draft && <p role="status" className="px-2 py-1 text-xs text-amber-800">Finish or cancel your text edit first.</p>}
      {SUPPORTED_LANGUAGES.map(item => <button key={item.code} type="button" role="menuitemradio"
        aria-checked={translation.language === item.code} disabled={draft && item.code !== 'en-IN'}
        autoFocus={item.code === (translation.language === 'en-IN' ? translation.preferredLanguage : translation.language)}
        onClick={() => { translation.setLanguage(item.code); if (item.code !== 'en-IN') onTranslate?.(); setOpen(false); }}
        className="block w-full rounded-lg px-3 py-2 text-left text-sm text-neutral-800 hover:bg-indigo-50 disabled:opacity-40">
        {item.code === 'en-IN' ? 'Show original (English)' : `${item.label} · ${item.name}`}{translation.language === item.code ? ' ✓' : ''}
      </button>)}
    </div>}
  </div>;
}

export function TranslationPrivacyNote() {
  const translation = useTranslation();
  if (!translation?.privacyNotice) return null;
  return <aside role="status" className="flex items-center gap-3 border-b border-indigo-200 bg-indigo-50 px-4 py-2 text-xs text-indigo-950">
    <span>{TRANSLATION_PRIVACY}</span>
    <button type="button" onClick={translation.dismissPrivacy} aria-label="Dismiss translation privacy note" className="ml-auto rounded px-2 py-1">×</button>
  </aside>;
}
