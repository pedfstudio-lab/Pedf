import { describe, expect, it } from 'vitest';
import type { TextEdit } from '@/lib/export/types';
import type { TextBlock, TextLine } from '@/lib/pdf/textContent';
import { editorWidthMeasurementText, listSeedText, paragraphSeedText } from './paragraphSeed';

const style = {
  fontName: 'Helvetica',
  fontSizePt: 12,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
};

function paragraph(...texts: string[]): TextBlock {
  const lines = texts.map((text, index): TextLine => ({
    pageIndex: 0,
    text,
    rect: { x: 40, y: 700 - index * 16, w: 300, h: 14 },
    baselineY: 700 - index * 16,
    style,
    runs: [],
  }));
  return {
    pageIndex: 0,
    text: texts.join('\n'),
    rect: { x: 40, y: 650, w: 300, h: Math.max(14, texts.length * 16) },
    topBaselineY: 700,
    lineHeightPt: 16,
    style,
    lines,
  };
}

describe('paragraphSeedText', () => {
  it('joins paragraph lines with one space', () => {
    expect(paragraphSeedText(paragraph('A number of', 'Postgraduate Departments', 'serve students')))
      .toBe('A number of Postgraduate Departments serve students');
  });

  it.each(['-', '\u2011'])('rejoins a lowercase word split with %s', (hyphen) => {
    expect(paragraphSeedText(paragraph(`Postgra${hyphen}`, 'duate Departments')))
      .toBe('Postgraduate Departments');
  });

  it('keeps a hyphen when the next line starts with a capital', () => {
    expect(paragraphSeedText(paragraph('Delhi-', 'Mumbai corridor')))
      .toBe('Delhi- Mumbai corridor');
  });

  it('collapses runs of spaces across a paragraph', () => {
    expect(paragraphSeedText(paragraph('A  number', 'of   departments')))
      .toBe('A number of departments');
  });

  it('returns a single-line block unchanged', () => {
    expect(paragraphSeedText(paragraph('Keep  these spaces'))).toBe('Keep  these spaces');
  });

  it('does not add a second space when a line already ends with one', () => {
    expect(paragraphSeedText(paragraph('First line ', 'second line')))
      .toBe('First line second line');
  });
});

describe('listSeedText', () => {
  it('seeds nine one-line items as nine editor lines', () => {
    const seed = listSeedText(paragraph(
      '• First item',
      '• Second item',
      '• Third item',
      '• Fourth item',
      '• Fifth item',
      '• Sixth item',
      '• Seventh item',
      '• Eighth item',
      '• Ninth item',
    ));

    expect(seed.split('\n')).toHaveLength(9);
    expect(seed.match(/\n/g)).toHaveLength(8);
  });

  it('joins continuation lines only within their own list item', () => {
    expect(listSeedText(paragraph(
      '• First item wraps',
      'onto another line',
      '• Second item',
      '• Third item also',
      'wraps onto another line',
      '• Fourth item',
      '• Fifth item',
      'and keeps flowing',
    ))).toBe([
      '• First item wraps onto another line',
      '• Second item',
      '• Third item also wraps onto another line',
      '• Fourth item',
      '• Fifth item and keeps flowing',
    ].join('\n'));
  });

  it('keeps prose flowing and rejoins a split lowercase word', () => {
    expect(listSeedText(paragraph('A Postgra-', 'duate programme')))
      .toBe('A Postgraduate programme');
  });

  it('returns a single-line block unchanged', () => {
    expect(listSeedText(paragraph('• Keep  these spaces'))).toBe('• Keep  these spaces');
  });

  it('keeps leading non-marker lines as a leading item', () => {
    expect(listSeedText(paragraph('Leading line', 'still leading', '• Marked item')))
      .toBe('Leading line still leading\n• Marked item');
  });
});

describe('editorWidthMeasurementText', () => {
  it('keeps source display lines while the paragraph seed flows', () => {
    const value = paragraph(
      'A number of Postgraduate Departments',
      'serve students across the region',
      'from one campus',
      'with another line',
      'and one more line',
      'before the end',
    );

    expect(editorWidthMeasurementText(value)).toBe(value.text);
    expect(editorWidthMeasurementText(value).match(/\n/g)).toHaveLength(5);
    expect(paragraphSeedText(value)).not.toContain('\n');
  });

  it('measures a previous edit from its wrapped lines, never boxText', () => {
    const existing: TextEdit[] = [
      {
        id: 'line-1',
        kind: 'text',
        pageIndex: 0,
        rect: { x: 40, y: 680, w: 180, h: 14 },
        z: 1,
        text: 'Wrapped first line',
        style,
        boxText: 'One long flowing value that is deliberately wider',
        boxHeight: 32,
      },
      {
        id: 'line-2',
        kind: 'text',
        pageIndex: 0,
        rect: { x: 40, y: 664, w: 150, h: 14 },
        z: 2,
        text: 'wrapped second line',
        style,
        boxText: 'One long flowing value that is deliberately wider',
        boxHeight: 32,
      },
    ];

    const measured = editorWidthMeasurementText(paragraph('Source line'), existing);
    expect(measured).toBe('Wrapped first line\nwrapped second line');
    expect(measured).not.toContain('One long flowing value');
  });

  it('returns a single-line block unchanged', () => {
    const value = paragraph('Single line');
    expect(editorWidthMeasurementText(value)).toBe(value.text);
  });
});
