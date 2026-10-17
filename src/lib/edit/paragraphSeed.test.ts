import { describe, expect, it } from 'vitest';
import type { TextEdit } from '@/lib/export/types';
import type { TextBlock, TextLine } from '@/lib/pdf/textContent';
import { editorWidthMeasurementText, listSeedText, paragraphSeedText, sourceParagraphLineHeight, sourceParagraphs } from './paragraphSeed';

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
    // These fixtures describe full wrapped lines, with known own-run advances.
    runs: [{ pageIndex: 0, text, rect: { x: 40, y: 700 - index * 16, w: 300, h: 14 }, style,
      characterWidthsPt: [...text].map(() => 300 / [...text].length), spaceWidthPt: 3 }],
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

describe('paragraph line spacing (Task 80 Fix A)', () => {
  function withSteps(steps: number[], widths: number[]): TextBlock {
    const block = paragraph(...widths.map((_, index) => `Item ${index} continues`));
    let baselineY = 700;
    return { ...block, lines: block.lines.map((line, index) => {
      baselineY -= index ? steps[index - 1]! : 0;
      const rect = { ...line.rect, y: baselineY, w: widths[index]! };
      return { ...line, rect, baselineY, runs: line.runs.map(run => ({ ...run, rect,
        characterWidthsPt: [...run.text].map(() => rect.w / [...run.text].length) })) };
    }) };
  }

  it('takes leading from wrapped lines even when item-start gaps are more common', () => {
    // Short final lines make real paragraph ends; full lines prove soft wraps.
    const block = withSteps([12, 16, 16, 12, 16, 16], [300, 50, 50, 300, 50, 50, 50]);
    expect(sourceParagraphLineHeight(block)).toBe(12);
    const seeded = sourceParagraphs(block);
    expect(seeded.lines.map(lines => lines.length)).toEqual([2, 1, 2, 1, 1]);
    expect(seeded.layouts.map(layout => layout.gapBeforePt)).toEqual([0, 4, 4, 4, 4]);
    expect(seeded.text.split('\n')).toHaveLength(5);
  });

  it('keeps the old modal rule with fewer than two within-paragraph steps', () => {
    const block = withSteps([12, 16, 16], [300, 50, 50, 50]);
    expect(sourceParagraphLineHeight(block)).toBe(16);
  });

  it('preserves uniform spacing and page-pitch fallback', () => {
    expect(sourceParagraphLineHeight(paragraph('one', 'two', 'three'))).toBe(16);
    expect(sourceParagraphLineHeight({ ...paragraph('one'), paragraphLineHeightPt: 13 })).toBe(13);
  });

  it('does not reinterpret centred or right-aligned rows or bullet leading', () => {
    const block = withSteps([12, 16, 16, 12, 16], [300, 50, 50, 300, 50, 50]);
    for (const align of ['center', 'right'] as const) {
      expect(sourceParagraphLineHeight({ ...block, align })).toBe(16);
      expect(sourceParagraphs({ ...block, align }).layouts).toEqual([{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }]);
      expect(sourceParagraphLineHeight({ ...withSteps([20, 12], [300, 300, 300]), align })).toBe(12);
    }
    const lines = block.lines.map(line => ({ ...line, text: `• ${line.text}` }));
    expect(sourceParagraphLineHeight({ ...block, lines })).toBe(16);
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
