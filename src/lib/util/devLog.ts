/** Timing and diagnostic notes for the local dev server only; the live site's console stays quiet. */
export function devInfo(...details: unknown[]): void {
  if (import.meta.env.DEV) console.info(...details);
}
