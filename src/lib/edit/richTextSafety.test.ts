// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { TextStyle } from '@/lib/export/types';
import { richTextToHtml } from './richText';
import { safeCssFontList } from './textStyleCss';

const style: TextStyle = { fontName: 'Helvetica', fontSizePt: 12, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };

describe('a crafted PDF cannot inject code or styles through the editor', () => {
  it('shows PDF text as text, and a booby-trapped font name adds no styles of its own', () => {
    const host = document.createElement('div');
    host.innerHTML = richTextToHtml('<script>alert(1)</script> & "quotes"', style, [{
      text: '<script>alert(1)</script> & "quotes"',
      bold: false,
      italic: false,
      fontName: 'Arial;background-image:url(https://tracker.example/x);color:red{}',
      fontRef: 'g_d0_f1"\n;color:red',
    }]);
    expect(host.querySelector('script')).toBeNull();
    const span = host.querySelector('span')!;
    expect(span.textContent).toBe('<script>alert(1)</script> & "quotes"');
    // The browser reads the style: nothing beyond the font settings HighPal wrote takes effect.
    expect(span.style.backgroundImage).toBe('');
    expect(span.style.color).toBe('');
    expect(span.getAttribute('style')).not.toMatch(/url\(|[{}]/);
  });

  it('leaves ordinary font names and lists exactly as they were', () => {
    expect(safeCssFontList('Times New Roman')).toBe('Times New Roman');
    expect(safeCssFontList('Arial, Helvetica, sans-serif')).toBe('Arial, Helvetica, sans-serif');
    expect(safeCssFontList('Noto Sans Devanagari')).toBe('Noto Sans Devanagari');
    expect(safeCssFontList(';{}()')).toBe('sans-serif');
  });
});
