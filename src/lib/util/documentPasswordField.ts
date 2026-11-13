/**
 * For passwords that belong to a PDF, not to a login on this site. Without this, Chrome fills
 * these boxes with any password it saved for the address (it once filled them with a saved API key),
 * and offers to save PDF passwords to the person's Google account.
 *
 * - `new-password`: Chrome and Safari never fill a saved password into it.
 * - data-* flags: 1Password, LastPass, Bitwarden and Dashlane leave the box alone.
 * The boxes also sit outside any <form>, which is what browsers treat as a login to remember.
 */
export const DOCUMENT_PASSWORD_FIELD = {
  autoComplete: 'new-password',
  spellCheck: false,
  autoCapitalize: 'none',
  autoCorrect: 'off',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const;
