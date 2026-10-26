/** PDF revision 6 passwords have a 127-byte UTF-8 limit. Never silently truncate. */
export function passwordProblem(password: string, confirmation: string): string | undefined {
  if (!password) return 'Set a password to lock your PDF.';
  if ([...password].length < 8 || !password.trim()) return 'Use at least 8 characters for your password.';
  if (new TextEncoder().encode(password).length > 127) return 'This password is too long. Use at most 127 UTF-8 bytes.';
  if (/[\p{Cc}\p{Cf}]/u.test(password) || password.normalize('NFKC') !== password) {
    return 'Use ordinary letters, numbers and symbols, without invisible or special formatting characters.';
  }
  if (password !== confirmation) return 'The passwords do not match.';
}
