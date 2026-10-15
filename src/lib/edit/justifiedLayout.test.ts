import { describe, expect, it } from 'vitest';
import type { TextSpan, TextStyle } from '@/lib/export/types';
import { justifiedComposition, minimumWordSpacing } from './justifiedLayout';
import { wrapTextParagraphs } from './paragraphLayout';

const style: TextStyle = { fontName: 'Helvetica', fontSizePt: 10, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
const span = (text: string, extra: Partial<TextSpan> = {}): TextSpan => ({ text, bold: false, italic: false, ...extra });
const measure = (text: string) => text.length * 5;

describe('justified model layout', () => {
  it('spreads only word gaps, preserves inline styles, and ends at the model column', () => {
    const composition = justifiedComposition({ text: 'one bold tail', spans: [span('one '), span('bold', { bold: true }), span(' tail')] }, style, 20, 700, 100, false, measure);
    expect(composition.pieces.map(piece => [piece.text, piece.x, piece.style.bold])).toEqual([
      ['one', 20, false], ['bold', 57.5, true], ['tail', 100, false],
    ]);
    const last = composition.pieces.at(-1)!;
    expect(last.x + last.widthPt).toBe(120);
  });

  it('uses normal gaps on final lines and before hard paragraph breaks', () => {
    const composition = justifiedComposition({ text: 'one two' }, style, 20, 700, 100, true, measure);
    expect(composition.pieces.map(piece => [piece.text, piece.x])).toEqual([['one', 20], ['two', 40]]);
    const lines = wrapTextParagraphs({ text: 'one two\nthree four', style, align: 'justify', width: 100, height: 50, dx: 0, dy: 0,
      paragraphs: [{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }, { gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }] }, measure);
    expect(lines.map(line => [line.text, line.paragraphIndex, line.paragraphStart])).toEqual([['one two', 0, true], ['three four', 1, true]]);
  });

  it('does not squeeze a paragraph without measured source narrowing', () => {
    expect(minimumWordSpacing([span('one two')], style, measure)).toBe(0);
    const lines = wrapTextParagraphs({ text: 'one two end', style, align: 'justify', width: 32, height: 50, dx: 0, dy: 0 }, measure);
    expect(lines.map(line => line.text)).toEqual(['one', 'two', 'end']);
  });

  it('never contracts gaps below the source minimum, including mixed-size spans', () => {
    const spans = [span('one '), span('two', { fontSizePt: 20 })];
    const sizeMeasure = (text: string, value: TextSpan) => text.length * (value.fontSizePt ?? 10) / 2;
    const spacing = minimumWordSpacing(spans, style, sizeMeasure, 0.15);
    expect(spacing).toBe(-3.5);
    for (const value of spans) expect(sizeMeasure(' ', value) + spacing).toBeGreaterThanOrEqual((value.fontSizePt ?? 10) * 0.15);
    const lines = wrapTextParagraphs({ text: 'one two end', style, align: 'justify', width: 32, height: 50, dx: 0, dy: 0,
      paragraphs: [{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0, minimumWordGapEm: 0.15 }] }, measure);
    expect(lines.map(line => line.text)).toEqual(['one two', 'end']);
    const composition = justifiedComposition(lines[0]!, style, 0, 700, 32, false, measure);
    expect(composition.pieces[1]!.x - composition.pieces[0]!.widthPt).toBe(2);
  });

  it('leaves a single word at the left instead of changing character spacing', () => {
    const composition = justifiedComposition({ text: 'alone' }, style, 20, 700, 100, false, measure);
    expect(composition.pieces).toHaveLength(1);
    expect(composition.pieces[0]!.x).toBe(20);
    expect(composition.pieces[0]!.widthPt).toBe(25);
  });

  it('wraps a compressed final line again rather than squeezing its normal gaps', () => {
    const lines = wrapTextParagraphs({ text: 'one two', style, align: 'justify', width: 32, height: 50, dx: 0, dy: 0,
      paragraphs: [{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0, minimumWordGapEm: 0.15 }] }, measure);
    expect(lines.map(line => line.text)).toEqual(['one', 'two']);
  });
});
