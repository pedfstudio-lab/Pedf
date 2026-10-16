import { describe, expect, it } from 'vitest';
import { fitTextToBlock, wrapTextSpansToLines, wrapTextToLines } from './textLayout';

const monospaceMeasure = (text: string) => text.length;

it('carries the optional matched-font identity and median scale through soft breaks', () => {
  const identity = { fontIdentity: 'HelveticaNowText', fontWidthScale: 0.93 };
  const lines = wrapTextSpansToLines([{ text: 'one two', bold: false, italic: false, ...identity }], 4, (text, span) => {
    expect(span).toMatchObject(identity);
    return text.length;
  });
  expect(lines.map(line => line.spans?.[0])).toEqual([
    { text: 'one', bold: false, italic: false, ...identity },
    { text: 'two', bold: false, italic: false, ...identity },
  ]);
});

describe.each(['plain', 'rich'] as const)('soft-break whitespace (%s)', (kind) => {
  const wrap = (text: string, width: number) => kind === 'plain'
    ? wrapTextToLines(text, width, monospaceMeasure)
    : wrapTextSpansToLines([{ text, bold: false, italic: false }], width, monospaceMeasure).map((line) => line.text);

  it('drops a separator that itself overflows, without adding an empty last line', () => {
    expect(wrap('ending with a golden sunset at Shanti Stupa', 20)).toEqual([
      'ending with a golden', 'sunset at Shanti', 'Stupa',
    ]);
    expect(wrap('golden ', 6)).toEqual(['golden']);
  });
  it('drops a fitting separator when the next word makes a soft break', () => {
    expect(wrap('golden sunset', 8)).toEqual(['golden', 'sunset']);
  });
  it('keeps typed indentation, internal double spaces and explicit blank lines', () => {
    expect(wrap('  a  b\n   c  d\n\n', 20)).toEqual(['  a  b', '   c  d', '', '']);
    expect(wrap('   a longer\n   b longer', 7)).toEqual(['   a', 'longer', '   b', 'longer']);
    expect(wrap('    word', 3)).toEqual(['   ', ' ', 'wor', 'd']);
  });
  it('still splits long words and preserves whitespace-only logical lines', () => {
    expect(wrap('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
    expect(wrap('   \n', 3)).toEqual(['   ', '']);
  });
});

it('keeps the styled words on both sides of a discarded wrap separator', () => {
  const bold = { bold: true, italic: false, fontRef: 'own-bold', color: { r: 1, g: 0, b: 0 }, sourceBold: true };
  const lines = wrapTextSpansToLines([
    { text: 'golden ', bold: false, italic: false },
    { text: 'Highlights', ...bold },
  ], 6, monospaceMeasure);
  expect(lines).toEqual([
    { text: 'golden', spans: [{ text: 'golden', bold: false, italic: false }] },
    { text: 'Highli', spans: [{ text: 'Highli', ...bold }] },
    { text: 'ghts', spans: [{ text: 'ghts', ...bold }] },
  ]);
});

describe('wrapTextToLines', () => {
  it('wraps words greedily and preserves explicit newlines', () => {
    expect(wrapTextToLines('one two three\nfour five', 7, monospaceMeasure)).toEqual([
      'one two',
      'three',
      'four',
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

describe('wrapTextSpansToLines', () => {
  it('keeps colour and intrinsic-weight metadata while wrapping', () => {
    const red = { r: 0.8, g: 0.1, b: 0.2 };
    const result = wrapTextSpansToLines([
      {
        text: 'red words',
        bold: true,
        italic: false,
        color: red,
        sourceBold: true,
        sourceStrokeBold: true,
        colorKnown: true,
      },
    ], 4, (text) => text.length);

    expect(result.flatMap((line) => line.spans ?? [])).toEqual([
      expect.objectContaining({
        text: 'red', color: red, sourceBold: true, sourceStrokeBold: true, colorKnown: true,
      }),
      expect.objectContaining({
        text: 'word', color: red, sourceBold: true, sourceStrokeBold: true, colorKnown: true,
      }),
      expect.objectContaining({
        text: 's', color: red, sourceBold: true, sourceStrokeBold: true, colorKnown: true,
      }),
    ]);
  });

  it('splits a styled span at the width limit while carrying its flags to both lines', () => {
    const result = wrapTextSpansToLines([
      { text: 'go ', bold: false, italic: false },
      { text: 'abcdef', bold: true, italic: false },
    ], 5, (text) => text.length);

    expect(result).toEqual([
      { text: 'go', spans: [{ text: 'go', bold: false, italic: false }] },
      { text: 'abcde', spans: [{ text: 'abcde', bold: true, italic: false }] },
      { text: 'f', spans: [{ text: 'f', bold: true, italic: false }] },
    ]);
  });

  it('measures each style independently and preserves explicit blank lines', () => {
    const result = wrapTextSpansToLines([
      { text: 'a\n\n', bold: false, italic: false },
      { text: 'bb', bold: true, italic: true },
    ], 3, (text, span) => text.length * (span.bold ? 2 : 1));

    expect(result).toEqual([
      { text: 'a', spans: [{ text: 'a', bold: false, italic: false }] },
      { text: '' },
      { text: 'b', spans: [{ text: 'b', bold: true, italic: true }] },
      { text: 'b', spans: [{ text: 'b', bold: true, italic: true }] },
    ]);
  });

  it('wraps two sizes by their own widths and preserves their overrides', () => {
    const result = wrapTextSpansToLines([
      { text: 'ab ', bold: false, italic: false, fontSizePt: 10 },
      { text: 'CD', bold: false, italic: false, fontSizePt: 20, fontName: 'Times New Roman' },
    ], 4, (text, span) => text.length * ((span.fontSizePt ?? 10) / 10));

    expect(result).toEqual([
      {
        text: 'ab',
        spans: [{ text: 'ab', bold: false, italic: false, fontSizePt: 10 }],
      },
      {
        text: 'CD',
        spans: [{
          text: 'CD',
          bold: false,
          italic: false,
          fontSizePt: 20,
          fontName: 'Times New Roman',
        }],
      },
    ]);
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
