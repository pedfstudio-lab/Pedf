export const MAX_UNLOCK_BYTES = 200 * 1024 * 1024;
export type UnlockErrorCode = 'invalid' | 'password' | 'unsupported' | 'failed';
export interface UnlockRequest { bytes: ArrayBuffer; password: string }
export type UnlockResponse = { type: 'done'; bytes: ArrayBuffer } | { type: 'error'; code: UnlockErrorCode };

export const UNLOCK_ERRORS: Record<UnlockErrorCode, string> = {
  invalid: 'This PDF could not be read. Try Repair PDF.',
  password: "That password isn't right. Try again.",
  unsupported: 'Unlocking PDFs is not available in this browser. Try a current version of Chrome, Edge, Firefox or Safari.',
  failed: "This PDF couldn't be unlocked. Your file is unchanged. Please try again.",
};

export class UnlockPdfError extends Error {
  constructor(readonly code: UnlockErrorCode) { super(UNLOCK_ERRORS[code]); this.name = 'UnlockPdfError'; }
}
