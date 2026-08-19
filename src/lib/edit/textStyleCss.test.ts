import { describe, expect, it } from 'vitest';
import type { TextStyle } from '@/lib/export/types';
import { textStyleToCanvasFont, textStyleToCss } from './textStyleCss';

const serifStyle: TextStyle = {
  fontName: 'ABCDEE+Cambria',
  fontSizePt: 12,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
};

describe('serif screen/export font parity', () => {
  it('uses the Times stack for on-screen serif text', () => {
    expect(textStyleToCss(serifStyle, 1).fontFamily)
      .toBe('"Times New Roman", Times, serif');
  });

  it('uses the same Times stack for width measurement', () => {
    expect(textStyleToCanvasFont(serifStyle))
      .toBe('normal 400 12px "Times New Roman", Times, serif');
  });

  it('puts the pdf.js embedded face first for preview and width measurement', () => {
    const embedded = { ...serifStyle, fontRef: 'g_d0_f2' };
    expect(textStyleToCss(embedded, 1).fontFamily)
      .toBe('"g_d0_f2", "Times New Roman", Times, serif');
    expect(textStyleToCanvasFont(embedded))
      .toBe('normal 400 12px "g_d0_f2", "Times New Roman", Times, serif');
  });
});
