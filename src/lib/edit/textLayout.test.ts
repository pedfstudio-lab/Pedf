import { describe, expect, it } from 'vitest';
import { fitTextToBlock, wrapTextToLines } from './textLayout';

const monospaceMeasure = (text: string) => text.length;

describe('wrapTextToLines', () => {
  it('wraps words greedily and preserves explicit newlines', () => {
    expect(wrapTextToLines('one two three\nfour five', 7, monospaceMeasure)).toEqual([
      'one two',
      ' three',
      'four ',
      'five',
    ]);
  });

  it('preserves every explicit blank textarea line', () => {
    expect(wrapTextToLines('line one\n\nline two\n', 20, monospaceMeasure)).toEqual([
      'line one',
      '',
      'line two',
      '',
    ]);
    expect(wrapTextToLines('', 20, monospaceMeasure)).toEqual([]);
  });

  it('preserves repeated, leading, and trailing spaces', () => {
    expect(wrapTextToLines('  a   b  ', 20, monospaceMeasure)).toEqual(['  a   b  ']);
  });

  it('produces fewer soft-wrapped lines when the box is wider', () => {
    const narrow = wrapTextToLines('a bb ccc', 4, monospaceMeasure);
    const wide = wrapTextToLines('a bb ccc', 20, monospaceMeasure);

    expect(narrow.length).toBeGreaterThan(wide.length);
    expect(wide).toEqual(['a bb ccc']);
  });

  it('splits a single word that is wider than the editable block', () => {
    expect(wrapTextToLines('abcdefgh', 3, monospaceMeasure)).toEqual(['abc', 'def', 'gh']);
  });

  it('rejects a non-positive width', () => {
    expect(() => wrapTextToLines('text', 0, monospaceMeasure)).toThrow(RangeError);
  });
});

describe('fitTextToBlock', () => {
  const fit = (text: string, width: number, height: number, maxFontSizePt = 12) =>
    fitTextToBlock({
      text,
      width,
      height,
      maxFontSizePt,
      minFontSizePt: 4,
      measureAtSize: (value, size) => value.length * size * 0.5,
      lineHeightAtSize: (size) => size * 1.25,
    });

  it('keeps the largest requested size when the wrapped text already fits', () => {
    const result = fit('Short name', 120, 20, 12);

    expect(result.fontSizePt).toBe(12);
    expect(result.lines).toEqual(['Short name']);
    expect(result.usedHeightPt).toBe(12);
  });

  it('shrinks long wrapped text to stay inside both the original width and height', () => {
    const result = fit(
      'A considerably longer replacement paragraph that must wrap inside its original box',
      72,
      36,
      12,
    );

    expect(result.fontSizePt).toBeLessThan(12);
    expect(result.usedHeightPt).toBeLessThanOrEqual(36.001);
    for (const line of result.lines) {
      expect(line.length * result.fontSizePt * 0.5).toBeLessThanOrEqual(72.001);
    }

    const slightlyLarger = result.fontSizePt + 0.001;
    const largerLines = wrapTextToLines(
      'A considerably longer replacement paragraph that must wrap inside its original box',
      72,
      (value) => value.length * slightlyLarger * 0.5,
    );
    const largerHeight = slightlyLarger + (largerLines.length - 1) * slightlyLarger * 1.25;
    expect(largerHeight).toBeGreaterThan(36);
  });

  it('preserves explicit paragraph grouping while fitting', () => {
    const result = fit('First paragraph\nSecond paragraph', 120, 36, 12);

    expect(result.lines).toEqual(['First paragraph', 'Second paragraph']);
    expect(result.usedHeightPt).toBeLessThanOrEqual(36.001);
  });
});
