import { describe, expect, it } from 'vitest';
import type { TextStyle } from '@/lib/export/types';
import {
  finalizeTextSpans,
  normalizeTextSpans,
  richTextToHtml,
  serializeRichText,
} from './richText';

const style: TextStyle = {
  fontName: 'Helvetica',
  fontSizePt: 12,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
};

interface FakeNode {
  readonly nodeType: number;
  readonly nodeValue?: string;
  readonly tagName?: string;
  readonly style?: {
    readonly fontWeight?: string;
    readonly fontStyle?: string;
    readonly fontSize?: string;
    readonly fontFamily?: string;
  };
  readonly dataset?: {
    readonly fontSizePt?: string;
    readonly fontName?: string;
    readonly fontRef?: string;
  };
  readonly childNodes?: readonly FakeNode[];
}

const text = (value: string): FakeNode => ({ nodeType: 3, nodeValue: value });
const element = (
  tagName: string,
  childNodes: readonly FakeNode[],
  elementStyle: FakeNode['style'] = {},
  dataset: FakeNode['dataset'] = {},
): FakeNode => ({ nodeType: 1, tagName, style: elementStyle, dataset, childNodes });

describe('rich text serialization', () => {
  it('walks a mixed bold/italic DOM tree and collapses adjacent equal runs', () => {
    const root = element('DIV', [
      text('Plain '),
      element('B', [text('bold'), text(' words')]),
      text(' and '),
      element('I', [text('italic')]),
    ]);

    const result = serializeRichText(root as unknown as HTMLElement, style);

    expect(result.text).toBe('Plain bold words and italic');
    expect(result.spans).toEqual([
      { text: 'Plain ', bold: false, italic: false },
      { text: 'bold words', bold: true, italic: false },
      { text: ' and ', bold: false, italic: false },
      { text: 'italic', bold: false, italic: true },
    ]);
  });

  it('emits no spans when the whole box is uniform and moves flags to the base style', () => {
    const result = finalizeTextSpans([
      { text: 'All ', bold: true, italic: false },
      { text: 'bold', bold: true, italic: false },
    ], style);

    expect(result).toEqual({
      text: 'All bold',
      style: { ...style, bold: true, italic: false },
    });
  });

  it('normalizes line endings, removes empties, and merges equal neighbours', () => {
    expect(normalizeTextSpans([
      { text: 'one\r\n', bold: false, italic: false },
      { text: '', bold: true, italic: false },
      { text: 'two', bold: false, italic: false },
    ])).toEqual([{ text: 'one\ntwo', bold: false, italic: false }]);
  });

  it('keeps adjacent size and family overrides as distinct span identities', () => {
    expect(normalizeTextSpans([
      { text: 'base', bold: false, italic: false },
      { text: 'large', bold: false, italic: false, fontSizePt: 18 },
      { text: 'serif', bold: false, italic: false, fontName: 'Times New Roman' },
      { text: ' serif', bold: false, italic: false, fontName: 'Times New Roman' },
    ])).toEqual([
      { text: 'base', bold: false, italic: false },
      { text: 'large', bold: false, italic: false, fontSizePt: 18 },
      { text: 'serif serif', bold: false, italic: false, fontName: 'Times New Roman' },
    ]);
  });

  it('serializes exact inline size and family overrides at the editor zoom', () => {
    const root = element('DIV', [
      text('Normal '),
      element(
        'SPAN',
        [text('large serif')],
        { fontSize: '27px', fontFamily: 'Times New Roman' },
        { fontSizePt: '18', fontName: 'Times New Roman' },
      ),
    ]);

    expect(serializeRichText(root as unknown as HTMLElement, style, 1.5).spans).toEqual([
      { text: 'Normal ', bold: false, italic: false },
      {
        text: 'large serif',
        bold: false,
        italic: false,
        fontSizePt: 18,
        fontName: 'Times New Roman',
      },
    ]);
  });

  it('renders span overrides as lossless inline editor styles', () => {
    const html = richTextToHtml('Big serif', style, [{
      text: 'Big serif',
      bold: true,
      italic: false,
      fontSizePt: 16,
      fontName: 'Times New Roman',
    }], 2);

    expect(html).toContain('font-size:32px');
    expect(html).toContain('font-family:Times New Roman');
    expect(html).toContain('data-font-size-pt="16"');
    expect(html).toContain('data-font-name="Times New Roman"');
  });
});
