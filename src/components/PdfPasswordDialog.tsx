import { useEffect, useState } from 'react';
import { DOCUMENT_PASSWORD_FIELD } from '../lib/util/documentPasswordField';

interface PdfPasswordDialogProps {
  fileName: string;
  /** The last password typed didn't open the file. */
  incorrect: boolean;
  busy: boolean;
  onSubmit(password: string): void;
  onCancel(): void;
}

/**
 * Asks for a locked PDF's password. The password is handed straight to the unlock step and never stored.
 * The editor gives it a new `key` after each wrong try, so the box comes back empty with the cursor in it.
 */
export function PdfPasswordDialog({ fileName, incorrect, busy, onSubmit, onCancel }: PdfPasswordDialogProps) {
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const submit = () => {
    if (password && !busy) onSubmit(password);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-[195] flex items-center justify-center bg-neutral-950/45 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-password-title"
        aria-describedby="pdf-password-help"
        className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-6 shadow-2xl"
      >
        <h2 id="pdf-password-title" className="flex items-center gap-2 text-lg font-semibold text-neutral-900">
          <span aria-hidden="true">🔒</span> This PDF is password-protected
        </h2>
        <p className="mt-2 break-words text-sm text-neutral-600">
          Type the password for <em>{fileName}</em> to open it.
        </p>
        <label className="mt-4 block text-sm font-medium text-neutral-800">
          Password
          <input
            {...DOCUMENT_PASSWORD_FIELD}
            type={visible ? 'text' : 'password'}
            value={password}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
            aria-invalid={incorrect}
            aria-describedby={incorrect ? 'pdf-password-error' : undefined}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 block w-full rounded-md border border-neutral-400 px-3 py-2 text-base text-neutral-900 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-200"
          />
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm text-neutral-700">
          <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} />
          Show password
        </label>
        {incorrect && (
          <p id="pdf-password-error" role="alert" className="mt-3 text-sm font-medium text-danger-700">
            That password isn't right. Try again.
          </p>
        )}
        <div id="pdf-password-help" className="mt-4 space-y-1 rounded-md bg-neutral-50 p-3 text-xs text-neutral-600">
          <p><strong className="font-semibold text-neutral-800">e-Aadhaar:</strong> the first 4 letters of your name in CAPITALS, then your birth year (for example RAHU1990).</p>
          <p><strong className="font-semibold text-neutral-800">Bank statements:</strong> the email or SMS that came with it usually says what the password is.</p>
          <p>The password stays on this device. HighPal doesn't save it.</p>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-100 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !password}
            onClick={submit}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-brand-900 hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? 'Opening…' : 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}
