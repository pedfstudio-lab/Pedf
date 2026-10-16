import { describe, expect, it } from 'vitest';
import type { TextStyle } from '@/lib/export/types';
import { measureMatchedText, textStyleToCanvasFont, textStyleToCss } from './textStyleCss';
import { matchedCssFamily } from '@/lib/fonts/fontMatch';

const serifStyle: TextStyle = {
  fontName: 'ABCDEE+Cambria',
  fontSizePt: 12,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
};

describe('serif screen/export font parity', () => {
  it('applies optional PDF tracking to CSS and canvas, but leaves legacy styles alone', () => {
    const tracked = { ...serifStyle, fontTrackingEm: -0.05 };
    expect(textStyleToCss(tracked, 2).letterSpacing).toBe('-1.2000000000000002px');
    expect(textStyleToCss(serifStyle, 2).letterSpacing).toBeUndefined();
    const context = { measureText: (text: string) => ({ width: [...text].length * 6 }) } as CanvasRenderingContext2D;
    expect(measureMatchedText(context, 'A word', tracked)).toBeCloseTo(36 - 6 * 0.6, 8);
    expect(measureMatchedText(context, 'A word', serifStyle)).toBe(36);
  });
  it('uses the Times stack for on-screen serif text', () => {
    expect(textStyleToCss(serifStyle, 1).fontFamily)
      .toBe(`"${matchedCssFamily(serifStyle)}", "Times New Roman", Times, serif`);
  });

  it('uses the same Times stack for width measurement', () => {
    expect(textStyleToCanvasFont(serifStyle))
      .toBe(`normal 400 12px "${matchedCssFamily(serifStyle)}", "Times New Roman", Times, serif`);
  });

  it('puts the pdf.js embedded face first for preview and width measurement', () => {
    const embedded = { ...serifStyle, fontRef: 'g_d0_f2' };
    expect(textStyleToCss(embedded, 1).fontFamily)
      .toBe(`"g_d0_f2", "${matchedCssFamily(embedded)}", "Times New Roman", Times, serif`);
    expect(textStyleToCanvasFont(embedded))
      .toBe(`normal 400 12px "g_d0_f2", "${matchedCssFamily(embedded)}", "Times New Roman", Times, serif`);
  });
});
