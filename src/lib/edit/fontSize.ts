export const FONT_SIZE_PRESETS = [
  8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72,
] as const;

export const MIN_FONT_SIZE_PT = 4;
export const MAX_FONT_SIZE_PT = 400;

function roundFontSize(pt: number): number {
  return Math.round(pt * 100) / 100;
}

export function parseFontSizeInput(raw: string): number | undefined {
  const normalized = raw.trim();
  if (!/^\d+(?:\.\d+)?\s*(?:pt)?$/i.test(normalized)) return undefined;
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return undefined;
  return roundFontSize(Math.min(MAX_FONT_SIZE_PT, Math.max(MIN_FONT_SIZE_PT, parsed)));
}

export function formatFontSize(pt: number): string {
  return String(roundFontSize(pt));
}
