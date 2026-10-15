import { describe, expect, it } from 'vitest';
import type { TextBlock } from '@/lib/pdf/textContent';
import type { TextStyle } from '@/lib/export/types';
import { wrapTextParagraphs } from './paragraphLayout';
import { buildTextBlockEdits, type NextTextEdit } from './buildTextEdits';

const style: TextStyle = { fontName: 'Helvetica', fontSizePt: 10, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
function fixture(texts: readonly string[], width = 65): TextBlock {
  const lines = texts.map((text, index) => {
    const y = 700 - index * 20, rect = { x: 40, y, w: width, h: 10 };
    return { pageIndex: 0, text, rect, baselineY: y, style, runs: [{ pageIndex: 0, text, rect, style, spaceWidthPt: 5,
      metrics: { matrix: [10, 0, 0, 10, 40, y] as const, x: 40, baselineY: y, widthPt: width } }] };
  });
  return { pageIndex: 0, text: texts.join('\n'), lines, style, rect: { x: 40, y: 680, w: width, h: 30 }, topBaselineY: 700, lineHeightPt: 20 };
}
describe('paragraph column layout', () => {
  it('reflows when piece estimates exceed the column even though editor advances fit', () => {
    const block = fixture(['alpha beta', 'gamma delta']);
    const next: NextTextEdit = { text: 'alpha golden beta gamma delta', style, width: 65, height: 40, dx: 0, dy: 0,
      paragraphs: [{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }], preserveSourceWrapping: true,
      measurePiece: (text, _style, source) => text.length * (source ? 5 : 3) };
    const lines = wrapTextParagraphs(next, text => text.length * 3, block);
    expect(lines.map(line => line.text)).toEqual(['alpha golden', 'beta gamma', 'delta']);
    expect(lines.every(line => line.compositionFallback === 'piece-layout-exceeds-column')).toBe(true);
    const built = buildTextBlockEdits(block, next, lines, 0);
    expect(built.texts.every(edit => !edit.composition && edit.compositionFallback === 'piece-layout-exceeds-column')).toBe(true);
    expect(built.texts.every(edit => edit.text.length * 5 <= edit.rect.w + 0.5)).toBe(true);
  });
  it('also rejects an overflowing composed row when a caller supplies its own wrapping', () => {
    const block = fixture(['alpha beta', 'gamma delta']);
    const built = buildTextBlockEdits(block, { text: 'alpha golden beta gamma delta', style, width: 65, height: 40, dx: 0, dy: 0,
      paragraphs: [{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }],
      measurePiece: text => text.length * 5 }, ['alpha golden beta', 'gamma delta'], 0);
    expect(built.texts.map(edit => edit.text)).toEqual(['alpha golden', 'beta gamma', 'delta']);
    expect(built.texts[0]?.composition).toBeUndefined();
    expect(built.texts[0]?.compositionFallback).toBe('piece-layout-exceeds-column');
  });
  it('uses the supplied displayed-face metrics to place rows after a same-count inline size change', () => {
    const block = fixture(['Label', 'Body'], 100);
    const next: NextTextEdit = { text: 'Label\nBody', style, width: 100, height: 40, dx: 0, dy: 0,
      paragraphs: [{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }, { gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }],
      fontMetrics: { ascent: 0.8, descent: 0.2 }, measurePiece: text => text.length * 5 };
    const built = buildTextBlockEdits(block, next, [{ text: 'Label', paragraphIndex: 0, paragraphStart: true, spans: [{ text: 'Label', bold: false, italic: false, fontSizePt: 14 }] },
      { text: 'Body', paragraphIndex: 1, paragraphStart: true }], 0);
    expect(built.texts[1]!.rect.y).toBeCloseTo(677.2, 9);
    expect(built.texts[1]!.composition?.pieces[0]!.baselineY).toBeCloseTo(677.2, 9);
    expect(built.texts[1]!.composition?.pieces[0]!.sourceVisible).not.toBe(true);
  });
});
