import { describe, expect, it } from 'vitest';
import type { TextStyle } from '@/lib/export/types';
import type { TextBlock, TextLine } from '@/lib/pdf/textContent';
import { hasLetterSpacedHeading, isLetterSpacedLine } from './letterSpacedHeading';

const style: TextStyle = { fontName: 'Helvetica', fontSizePt: 18, bold: false, italic: false, color: { r: 1, g: 1, b: 1 } };
function line(pieces: readonly string[], separator = ' '): TextLine {
  const text = pieces.join(separator), rect = { x: 0, y: 0, w: 100, h: 18 };
  return { pageIndex: 0, text, rect, baselineY: 0, style, runs: pieces.map(piece => ({ pageIndex: 0, text: piece, rect, style })) };
}
const block = (lines: readonly TextLine[]): TextBlock => ({
  pageIndex: 0, text: lines.map(item => item.text).join('\n'), style, lines, rect: { x: 0, y: 0, w: 100, h: 40 }, topBaselineY: 0, lineHeightPt: 20,
});

describe('letter-spaced heading test', () => {
  it('keeps a spaced-out heading, even in a box with an ordinary line', () => {
    const heading = line(['N E W', 'Y E A R ’ S', 'T R I P']);
    expect(isLetterSpacedLine(heading)).toBe(true);
    expect(hasLetterSpacedHeading(block([heading, line(['26TH DEC - 2ND JAN'])]))).toBe(true);
  });

  it('ignores one N E W-style piece cut out of ordinary prose (Ladakh p2 "wit|h a b|unch")', () => {
    const prose = line(['Now imagine experiencing all of this wit', 'h a b', 'unch of strangers who'], '');
    expect(isLetterSpacedLine(prose)).toBe(false);
    expect(hasLetterSpacedHeading(block([line(['And then there are the nights, where Hanle’s sky turns into a']), prose]))).toBe(false);
  });

  it('needs most of the line, not just some of it', () => {
    expect(isLetterSpacedLine(line(['A B C', 'ordinary words here']))).toBe(false);
    expect(isLetterSpacedLine(line(['A B C D E F', 'and']))).toBe(true);
    expect(isLetterSpacedLine(line(['   ']))).toBe(false);
  });
});
