export const MAX_LOCK_BYTES = 100 * 1024 * 1024;
export type LockErrorCode = 'invalid' | 'locked' | 'signed' | 'unsupported' | 'failed' | 'password';
export type LockProgress = 'checking' | 'encrypting';
export interface LockRequest { bytes: ArrayBuffer; password: string }
export type LockResponse = { type: 'progress'; phase: LockProgress }
  | { type: 'done'; bytes: ArrayBuffer }
  | { type: 'error'; code: LockErrorCode };

export const LOCK_ERRORS: Record<LockErrorCode, string> = {
  invalid: 'This PDF could not be read. Try Repair PDF, then lock the repaired copy.',
  locked: 'This PDF is already password-protected or restricted. Choose an unlocked copy.',
  signed: 'This PDF is digitally signed. Lock an unsigned copy so the signature is not invalidated.',
  unsupported: 'Secure PDF locking is not available in this browser. Try a current version of Chrome, Edge, Firefox or Safari.',
  failed: 'The PDF could not be locked. Your original file is unchanged. Please try again.',
  password: 'The password could not be used. Check the password requirements and try again.',
};

export class LockPdfError extends Error {
  constructor(readonly code: LockErrorCode) { super(LOCK_ERRORS[code]); this.name = 'LockPdfError'; }
}
