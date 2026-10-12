import { describe, expect, it } from 'vitest';
import { OPS } from 'pdfjs-dist';
import { sourceTextMetrics, textStatesForItems } from './textMetrics';

const item = { str: 'AB', dir: 'ltr', width: 12, height: 10, transform: [10, 0, 0, 10, 82.123456789, 400.987654321], fontName: 'f', hasEOL: false };
describe('source text metrics', () => {
  it('keeps raw transform/origin/baseline and font metrics without viewport rounding', () => {
    expect(sourceTextMetrics(item, { fontFamily: 'Helvetica', ascent: 0.9, descent: -0.2, vertical: false })).toEqual({
      matrix: item.transform, x: item.transform[4], baselineY: item.transform[5], widthPt: 12, ascent: 0.9, descent: -0.2,
    });
  });
  it('captures Tc, Tw, leading and horizontal scale, restoring graphics state', () => {
    const list = { fnArray: [OPS.setFont, OPS.setCharSpacing, OPS.setWordSpacing, OPS.setLeading, OPS.setHScale, OPS.save, OPS.setCharSpacing, OPS.restore, OPS.showText],
      argsArray: [['f', 10], [1], [2], [12], [80], [], [9], [], [[{ unicode: 'A', width: 500 }, { unicode: 'B', width: 500 }]]] };
    const state = textStatesForItems([item], list)[0];
    expect(sourceTextMetrics(item, undefined, state)).toMatchObject({ characterSpacing: 1, wordSpacing: 2, leading: 12, horizontalScale: 0.8 });
    expect(sourceTextMetrics(item, undefined, state).glyphs).toEqual([{ text: 'A', offsetPt: 0, widthPt: 5 }, { text: 'B', offsetPt: 6, widthPt: 5 }]);
  });
  it('leaves operator metrics absent on a failed text association, not guessed zero', () => {
    const states = textStatesForItems([item], { fnArray: [OPS.showText], argsArray: [[[{ unicode: 'X', width: 500 }]]] });
    expect(states[0]).toBeUndefined();
    expect(sourceTextMetrics(item, undefined, states[0]).characterSpacing).toBeUndefined();
  });
});
