/** A PDF that needs its password: `needed` when none was given, `incorrect` when the typed one didn't open it. */
export class PdfPasswordError extends Error {
  constructor(readonly reason: 'needed' | 'incorrect') {
    super(reason === 'needed' ? 'This PDF is locked with a password.' : "That password isn't right. Try again.");
    this.name = 'PdfPasswordError';
  }
}
