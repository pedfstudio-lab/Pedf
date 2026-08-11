import { useEffect, useState } from 'react';
import { clearSarvamKey, getSarvamKey, setSarvamKey } from '@/lib/providers/keys';
import {
  SUPPORTED_LANGUAGES,
  usePrefs,
} from '@/state/prefsStore';
import type { SupportedLanguageCode } from '@/state/prefsStore';

interface SettingsPanelProps {
  readonly open: boolean;
  onClose(): void;
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const { preferredLanguage, setPreferredLanguage } = usePrefs();
  const [keyDraft, setKeyDraft] = useState('');
  const [keyIsSet, setKeyIsSet] = useState(
    () => import.meta.env.DEV && getSarvamKey() !== '',
  );

  useEffect(() => {
    if (!open) return;
    setKeyDraft('');
    if (import.meta.env.DEV) setKeyIsSet(getSarvamKey() !== '');
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-neutral-950/45 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="w-full max-w-lg rounded-xl border border-neutral-200 bg-white p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 id="settings-title" className="text-xl font-semibold text-neutral-900">Settings</h2>
            <p className="mt-1 text-sm text-neutral-500">Language and provider preferences for this browser.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="rounded-md px-2 py-1 text-xl leading-none text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
          >
            ×
          </button>
        </div>

        <div className="mt-6 space-y-6">
          <section aria-labelledby="language-settings-title">
            <h3 id="language-settings-title" className="text-sm font-semibold text-neutral-900">Preferred language</h3>
            <p className="mt-1 text-sm text-neutral-500">Answers and speech will use this language when available.</p>
            <select
              aria-label="Preferred language"
              value={preferredLanguage}
              onChange={(event) => setPreferredLanguage(event.target.value as SupportedLanguageCode)}
              className="mt-3 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
            >
              {SUPPORTED_LANGUAGES.map(({ code, label }) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
          </section>

          <div className="h-px bg-neutral-200" />

          {import.meta.env.DEV ? (
            <section aria-labelledby="sarvam-settings-title">
              <div className="flex items-center justify-between gap-3">
                <h3 id="sarvam-settings-title" className="text-sm font-semibold text-neutral-900">Sarvam API key</h3>
                <span
                  role="status"
                  className={`rounded-full px-2 py-1 text-xs font-semibold ${keyIsSet ? 'bg-emerald-100 text-emerald-800' : 'bg-neutral-100 text-neutral-600'}`}
                >
                  {keyIsSet ? 'Set' : 'Not set'}
                </span>
              </div>
              <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <strong>Personal use only.</strong> The key is stored in this browser. Production keeps provider keys on the server.
              </div>
              <form
                className="mt-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  const key = keyDraft.trim();
                  if (!key) return;
                  setSarvamKey(key);
                  setKeyDraft('');
                  setKeyIsSet(true);
                }}
              >
                <label htmlFor="sarvam-key" className="sr-only">Sarvam API key</label>
                <input
                  id="sarvam-key"
                  type="password"
                  autoComplete="new-password"
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  placeholder={keyIsSet ? 'Enter a replacement key' : 'Enter your Sarvam API key'}
                  className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
                />
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={!keyIsSet}
                    onClick={() => {
                      clearSarvamKey();
                      setKeyDraft('');
                      setKeyIsSet(false);
                    }}
                    className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Clear
                  </button>
                  <button
                    type="submit"
                    disabled={keyDraft.trim() === ''}
                    className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
              </form>
            </section>
          ) : (
            <section aria-label="Provider key handling" className="text-sm text-neutral-600">
              Provider keys are handled securely by the server in production.
            </section>
          )}
        </div>
      </section>
    </div>
  );
}
