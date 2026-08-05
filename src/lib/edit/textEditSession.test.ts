import { describe, expect, it } from 'vitest';
import type { TextEditSessionValue } from './textEditSession';
import { calculateInitialEditorWidth, finishTextEdit } from './textEditSession';

const initial: TextEditSessionValue = {
  text: 'Boarding at 03:00 PM',
  style: {
    fontName: 'Helvetica',
    fontSizePt: 12,
    bold: false,
    italic: false,
    color: { r: 0.1, g: 0.2, b: 0.3 },
  },
  spans: [
    { text: 'Boarding at ', bold: false, italic: false },
    { text: '03:00 PM', bold: true, italic: false },
  ],
  width: 150,
  height: 16,
  dx: 0,
  dy: 0,
};

describe('finishTextEdit', () => {
  it('cancels an identical session instead of creating an edit', () => {
    const completed: TextEditSessionValue[] = [];
    let cancellations = 0;

    expect(finishTextEdit(
      initial,
      { ...initial, height: 16.4 },
      (next) => completed.push(next),
      () => { cancellations += 1; },
    )).toBe('cancelled');
    expect(completed).toEqual([]);
    expect(cancellations).toBe(1);
  });

  it.each([
    ['text', { ...initial, text: `${initial.text}!` }],
    ['font size', { ...initial, style: { ...initial.style, fontSizePt: 13 } }],
    ['bold', { ...initial, style: { ...initial.style, bold: true } }],
    ['font family', { ...initial, style: { ...initial.style, fontName: 'Times New Roman' } }],
    ['color', { ...initial, style: { ...initial.style, color: { ...initial.style.color, r: 0.4 } } }],
    ['spans', { ...initial, spans: initial.spans?.map((span, index) => index === 0 ? { ...span, italic: true } : span) }],
    ['width', { ...initial, width: 151 }],
    ['height', { ...initial, height: 16.6 }],
    ['horizontal position', { ...initial, dx: 1 }],
    ['vertical position', { ...initial, dy: -1 }],
  ])('commits when only %s changes', (_label, current) => {
    const completed: TextEditSessionValue[] = [];
    let cancellations = 0;

    expect(finishTextEdit(
      initial,
      current,
      (next) => completed.push(next),
      () => { cancellations += 1; },
    )).toBe('committed');
    expect(completed).toEqual([current]);
    expect(cancellations).toBe(0);
  });
});

describe('calculateInitialEditorWidth', () => {
  it('widens a short field enough for the standard-font line', () => {
    const width = calculateInitialEditorWidth({
      blockWidthPt: 80,
      blockXPt: 20,
      fontSizePt: 12,
      measuredLineWidthPt: 96,
      pageWidthPt: 400,
    });

    expect(width).toBeGreaterThanOrEqual(96);
    expect(width).toBeLessThanOrEqual(377);
  });

  it('clamps a wide paragraph at the page margin', () => {
    const width = calculateInitialEditorWidth({
      blockWidthPt: 80,
      blockXPt: 10,
      existingWidthPt: 90,
      fontSizePt: 12,
      measuredLineWidthPt: 140,
      pageWidthPt: 100,
      marginPt: 4,
    });

    expect(width).toBe(86);
  });
});
