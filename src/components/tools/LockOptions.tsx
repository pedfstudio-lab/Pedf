import { useState } from 'react';
import { parseLockOptions } from '@/lib/tools/lockOptions';
import type { ToolOptionsProps } from '@/lib/tools/types';

export function LockOptions({ options, onChange, disabled }: ToolOptionsProps) {
  const value = parseLockOptions(options);
  const [visible, setVisible] = useState(false);
  return <fieldset className="tool-options lock-options" disabled={disabled}>
    <legend>Set a password</legend>
    <p className="tool-hint" id="lock-password-help">Use at least 8 characters. A long, unique passphrase is best. Spaces are part of your password.</p>
    <label className="lock-field">Password
      <input type={visible ? 'text' : 'password'} value={value.password} autoComplete="off" spellCheck={false}
        autoCapitalize="none" autoCorrect="off" aria-describedby="lock-password-help"
        onChange={event => onChange({ ...value, password: event.target.value })} />
    </label>
    <label className="lock-field">Confirm password
      <input type={visible ? 'text' : 'password'} value={value.confirmation} autoComplete="off" spellCheck={false}
        autoCapitalize="none" autoCorrect="off" onChange={event => onChange({ ...value, confirmation: event.target.value })} />
    </label>
    <label className="tool-checkbox"><input type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} />Show passwords</label>
    <div className="lock-explainer">
      <strong>The password travels with the PDF.</strong>
      <p>Anyone opening the downloaded file in a compatible PDF reader will need this password. They do not need an R1 account.</p>
      <p>Keep the password safe and share it separately from the PDF. We do not store it and cannot recover it.</p>
      <p>Locking requires a password to open the file. It does not prevent someone who knows the password from saving or sharing a copy.</p>
    </div>
    <a className="tool-hint" href="/licenses/lock-pdf/NOTICE.txt" target="_blank" rel="noreferrer">Encryption engine and open-source notices</a>
  </fieldset>;
}
