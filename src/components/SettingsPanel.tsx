import { useEffect, useState } from 'react';
import { clearSarvamKey, getSarvamKey, setSarvamKey } from '@/lib/providers/keys';
import {
  SUPPORTED_LANGUAGES,
  usePrefs,
} from '@/state/prefsStore';
import type { SupportedLanguageCode } from '@/state/prefsStore';
import { projectStore as defaultProjectStore } from '@/lib/projects/projectStore';
import type { ProjectStore } from '@/lib/projects/projectStore';

interface SettingsPanelProps {
  readonly open: boolean;
  readonly fileOpen: boolean;
  readonly projectStore?: ProjectStore;
  onClose(): void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export function SettingsPanel({
  open,
  fileOpen,
  projectStore = defaultProjectStore,
  onClose,
}: SettingsPanelProps) {
  const { preferredLanguage, setPreferredLanguage } = usePrefs();
  const [keyDraft, setKeyDraft] = useState('');
  const [keyIsSet, setKeyIsSet] = useState(
    () => import.meta.env.DEV && getSarvamKey() !== '',
  );
  const [savedSummary, setSavedSummary] = useState({ count: 0, bytes: 0 });
  const [storageEstimate, setStorageEstimate] = useState<{ usage?: number; quota?: number }>({});
  const [savedFilesError, setSavedFilesError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKeyDraft('');
    if (import.meta.env.DEV) setKeyIsSet(getSarvamKey() !== '');
    let cancelled = false;
    void projectStore.list().then((result) => {
      if (cancelled) return;
      if (result.status === 'ok') {
        setSavedSummary({
          count: result.value.length,
          bytes: result.value.reduce((total, project) => total + project.fileSize, 0),
        });
        setSavedFilesError(false);
      } else {
        setSavedFilesError(true);
      }
    });
    try {
      void navigator.storage?.estimate?.().then((estimate) => {
        if (!cancelled) setStorageEstimate({ usage: estimate.usage, quota: estimate.quota });
      }).catch(() => undefined);
    } catch {
      // Storage estimates are optional and unavailable in some browsers.
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose, open, projectStore]);

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

          <section aria-labelledby="saved-files-settings-title">
            <h3 id="saved-files-settings-title" className="text-sm font-semibold text-neutral-900">Saved files on this device</h3>
            {savedFilesError ? (
              <p className="mt-1 text-sm text-neutral-500">Saved-file storage isn&apos;t available in this browser.</p>
            ) : (
              <>
                <p className="mt-1 text-sm text-neutral-500">
                  {savedSummary.count} {savedSummary.count === 1 ? 'file' : 'files'} saved · about {formatBytes(savedSummary.bytes)}
                </p>
                {storageEstimate.usage !== undefined && storageEstimate.quota !== undefined && (
                  <p className="mt-1 text-xs text-neutral-500">
                    Browser storage: {formatBytes(storageEstimate.usage)} used of {formatBytes(storageEstimate.quota)}.
                  </p>
                )}
              </>
            )}
            <p className="mt-2 text-xs text-neutral-500">Saved only in this browser on this device.</p>
            {fileOpen && <p className="mt-2 text-xs font-medium text-neutral-600">Close the open file first.</p>}
            <button
              type="button"
              disabled={fileOpen || savedSummary.count === 0 || savedFilesError}
              title={fileOpen ? 'Close the open file first.' : undefined}
              onClick={() => {
                if (!window.confirm("Delete all saved files on this device? This can't be undone.")) return;
                void projectStore.deleteAll().then((result) => {
                  if (result.status === 'ok') setSavedSummary({ count: 0, bytes: 0 });
                  else setSavedFilesError(true);
                });
              }}
              className="mt-3 rounded-md border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Delete all saved files on this device
            </button>
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
