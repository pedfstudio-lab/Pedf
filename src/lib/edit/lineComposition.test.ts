import { describe, expect, it } from 'vitest';
import type { TextComposition, TextStyle } from '@/lib/export/types';
import { composeTextLine, sourceLineComposition } from './lineComposition';

const style: TextStyle = { fontName: 'Helvetica', fontSizePt: 10, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
function source(alignment: TextComposition['alignment'] = 'left'): TextComposition {
  return { version: 1, text: 'NEW YEAR TRIP', style, alignment, alignmentLeftPt: 10, alignmentWidthPt: 250,
    pieces: [{ text: 'NEW', x: 10, baselineY: 700.123456789123, widthPt: 30, style },
      { text: 'YEAR', x: 90, baselineY: 700.123456789123, widthPt: 40, style },
      { text: 'TRIP', x: 180, baselineY: 700.123456789123, widthPt: 40, style }] };
}
function composed(text: string, alignment: TextComposition['alignment'] = 'left', extra = {}) {
  const result = composeTextLine(source(alignment), text, style, value => value.length * 10, extra);
  expect('composition' in result).toBe(true);
  if (!('composition' in result)) throw Error(result.reason);
  return result.composition;
}
describe('measured line composition', () => {
  it('keeps unchanged numbers exactly, without calling a width measurer', () => {
    const initial = source();
    const result = composeTextLine(initial, initial.text, style, () => { throw Error('must not remeasure untouched text'); });
    expect(result).toEqual({ composition: initial });
  });
  it('adds to the last piece, leaving the earlier pieces and both 50pt gaps intact', () => {
    const result = composed('NEW YEAR TRIPS');
    expect(result.pieces.map(piece => piece.x)).toEqual([10, 90, 180]);
    expect(result.pieces.map(piece => piece.widthPt)).toEqual([30, 40, 50]);
    expect(result.pieces.map(piece => piece.baselineY)).toEqual(source().pieces.map(piece => piece.baselineY));
  });
  it('widens a first piece and shifts only later pieces by the width delta', () => {
    const result = composed('NEWER YEAR TRIP');
    expect(result.pieces.map(piece => piece.x)).toEqual([10, 110, 200]);
    expect(result.pieces[1]!.x - result.pieces[0]!.x - result.pieces[0]!.widthPt).toBe(50);
    expect(result.pieces[2]!.x - result.pieces[1]!.x - result.pieces[1]!.widthPt).toBe(50);
  });
  it.each(['center', 'right'] as const)('keeps the measured %s anchor when a piece grows', alignment => {
    const result = composed('NEW YEAR TRIPS', alignment);
    expect(result.pieces[0]!.x).toBe(alignment === 'center' ? 5 : 0);
    const right = result.pieces[2]!.x + result.pieces[2]!.widthPt;
    expect(alignment === 'center' ? (result.pieces[0]!.x + right) / 2 : right).toBe(alignment === 'center' ? 115 : 220);
  });
  it('a second move starts from the saved composition, never the old source', () => {
    const first = composed('NEW YEAR TRIP', 'left', { dx: 10, dy: -8 });
    const second = composeTextLine(first, first.text, style, () => 0, { dx: 10, dy: -8 });
    expect('composition' in second && second.composition.pieces[0]!.x).toBe(30);
    expect('composition' in second && second.composition.pieces[0]!.baselineY).toBe(source().pieces[0]!.baselineY - 16);
  });
  it('re-evaluates source visibility after a move, so moved glyphs are not skipped', () => {
    const initial = source();
    const saved = { ...initial, pieces: initial.pieces.map(piece => ({ ...piece, sourceVisible: true })) };
    const result = composeTextLine(saved, saved.text, style, () => 0, { dx: 10 });
    expect('composition' in result && result.composition.pieces.every(piece => piece.sourceVisible === false)).toBe(true);
  });
  it('names fallbacks for whole-line replacement, separator edits and font-size changes', () => {
    expect(composeTextLine(source(), 'COMPLETELY DIFFERENT', style, () => 0)).toEqual({ reason: 'whole-line-retyped' });
    expect(composeTextLine(source(), 'NEW--YEAR TRIP', style, () => 0)).toEqual({ reason: 'edit-crosses-piece-boundary' });
    expect(composeTextLine(source(), source().text, { ...style, fontSizePt: 12 }, () => 0)).toEqual({ reason: 'font-size-changed' });
  });
  it('does not add literal spaces to reconstruct a source gap', () => {
    const value = source();
    const runs = value.pieces.map(piece => ({ pageIndex: 0, text: piece.text, style, rect: { x: piece.x, y: piece.baselineY, w: piece.widthPt, h: 10 },
      metrics: { matrix: [10, 0, 0, 10, piece.x, piece.baselineY] as const, x: piece.x, baselineY: piece.baselineY, widthPt: piece.widthPt } }));
    const result = sourceLineComposition({ pageIndex: 0, text: value.text, style, runs, rect: { x: 10, y: 700, w: 210, h: 10 }, baselineY: 700 });
    expect(result?.text).toBe('NEW YEAR TRIP');
    expect(result?.pieces.map(piece => piece.x)).toEqual([10, 90, 180]);
  });
});
