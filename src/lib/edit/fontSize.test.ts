import { describe, expect, it } from 'vitest';
import {
  formatFontSize,
  FONT_SIZE_PRESETS,
  MAX_FONT_SIZE_PT,
  MIN_FONT_SIZE_PT,
  parseFontSizeInput,
} from './fontSize';

describe('font size helpers', () => {
  it.each([
    ['12', 12],
    ['12.5', 12.5],
    [' 14pt ', 14],
    ['2', MIN_FONT_SIZE_PT],
    ['999', MAX_FONT_SIZE_PT],
  ])('parses %j as %s points', (raw, expected) => {
    expect(parseFontSizeInput(raw)).toBe(expected);
  });

  it.each(['abc', '', '-3'])('rejects %j without changing the size', (raw) => {
    expect(parseFontSizeInput(raw)).toBeUndefined();
  });

  it('formats rounded sizes without trailing zeroes', () => {
    expect(formatFontSize(11)).toBe('11');
    expect(formatFontSize(13.5)).toBe('13.5');
    expect(formatFontSize(12.345)).toBe('12.35');
  });

  it('exposes the requested preset list in order', () => {
    expect(FONT_SIZE_PRESETS).toEqual([
      8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72,
    ]);
  });
});
