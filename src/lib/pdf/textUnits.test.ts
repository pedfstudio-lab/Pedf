import { describe, expect, it } from 'vitest';
import type { TextStyle } from '@/lib/export/types';
import type { RuleLine } from './ruleLines';
import type { TextLine, TextRun } from './textContent';
import {
  canJoinTextBlock,
  canJoinTextBulletList,
  detectBlockAlignment,
  intrinsicBold,
  splitTextRow,
} from './textUnits';

const style = {
  fontName: 'Helvetica',
  fontSizePt: 10,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
};

function run(text: string, x: number, w: number, y = 500, size = 10): TextRun {
  return {
    pageIndex: 0,
    text,
    rect: { x, y, w, h: size },
    style: { ...style, fontSizePt: size },
  };
}

function line(text: string, x: number, y: number, w: number, size = 10): TextLine {
  const source = run(text, x, w, y, size);
  return {
    pageIndex: 0,
    text,
    rect: source.rect,
    baselineY: y,
    style: source.style,
    runs: [source],
  };
}

function rule(
  orientation: RuleLine['orientation'],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): RuleLine {
  return {
    pageIndex: 0,
    orientation,
    x1,
    y1,
    x2,
    y2,
    thicknessPt: 1,
    color: { r: 0, g: 0, b: 0 },
  };
}

describe('text row click units', () => {
  it('splits at a vertical border even when the gap is only 15.8 pt', () => {
    const runs = [run('Left cell', 10, 20), run('Right cell', 45.8, 35)];
    expect(splitTextRow(runs, [rule('vertical', 38, 498, 38, 511)]))
      .toEqual([[runs[0]], [runs[1]]]);
  });

  it('splits one isolated nine-times-font-size gap', () => {
    const runs = [run('email@example.com', 10, 80), run('City', 180, 25)];
    expect(splitTextRow(runs, [])).toEqual([[runs[0]], [runs[1]]]);
  });

  it('keeps three identical 1.9-times-font-size stretched gaps in one line', () => {
    const runs = [
      run('After', 10, 42, 500, 20),
      run('breakfast,', 90, 80, 500, 20),
      run('we', 208, 22, 500, 20),
      run('leave', 268, 45, 500, 20),
    ];
    expect(splitTextRow(runs, [])).toEqual([runs]);
  });

  it('allows half-point measurement noise at the three-times-size stretched limit', () => {
    const runs = [
      run('chortens', 10, 40),
      run('surrounded', 80.25, 50),
      run('by', 160.5, 12),
    ];
    expect(splitTextRow(runs, [])).toEqual([runs]);
  });

  it('keeps the compact table-number split', () => {
    const runs = [run('50.00%', 10, 40), run('100.00%', 55, 45)];
    expect(splitTextRow(runs, [])).toEqual([[runs[0]], [runs[1]]]);
  });
});

describe('fill-and-stroke bold phrases inside a paragraph', () => {
  function styled(source: TextLine, overrides: Partial<TextStyle>): TextLine {
    return { ...source, style: { ...source.style, ...overrides } };
  }

  it('judges a line by its face, not by bold painted onto a phrase', () => {
    expect(intrinsicBold({ ...style, bold: true, sourceBold: false })).toBe(false);
    expect(intrinsicBold({ ...style, bold: false, sourceBold: true })).toBe(true);
    // A project saved before sourceBold existed falls back to bold, unchanged.
    expect(intrinsicBold({ ...style, bold: true })).toBe(true);
    expect(intrinsicBold({ ...style, bold: false })).toBe(false);
  });

  it('joins a line whose longest run is a painted bold phrase to its plain neighbour', () => {
    // RAHUL_RAJPUT_RESUME.pdf: this line's longest run is the fill-and-stroke
    // phrase, so the line reads bold while its Lucida face is regular.
    const upper = line('Joined Firgun Travels three months ago and initially took', 20, 500, 210);
    const lower = styled(
      line('generating 60+ bookings within the first three months.', 20, 486, 210),
      { bold: true, sourceBold: false },
    );
    expect(canJoinTextBlock([upper], lower, [])).toBe(true);
  });

  it('still keeps a genuinely bold face apart from a plain one', () => {
    const upper = styled(
      line('A full-width line set in a genuinely bold face here', 20, 500, 210),
      { bold: true, sourceBold: true },
    );
    const lower = line('A full-width paragraph line set in the plain face', 20, 486, 210);
    expect(canJoinTextBlock([upper], lower, [])).toBe(false);
  });
});

describe('stacked text units', () => {
  it('never joins across a spanning horizontal border', () => {
    const upper = line('Upper paragraph line', 20, 500, 200);
    const lower = line('Lower paragraph line', 20, 486, 195);
    expect(canJoinTextBlock(
      [upper],
      lower,
      [rule('horizontal', 20, 493, 220, 493)],
    )).toBe(false);
  });

  it('keeps bullet items out of prose while retaining consecutive bullets as a list', () => {
    const breakfast = line('• Breakfast', 20, 500, 100);
    const continuation = line('with fresh fruit', 34, 486, 90);
    const dinner = line('• Dinner', 20, 472, 100);
    expect(canJoinTextBlock([breakfast], continuation, [])).toBe(true);
    expect(canJoinTextBlock([breakfast], dinner, [])).toBe(false);
    expect(canJoinTextBulletList([breakfast, continuation], dinner, [])).toBe(true);
  });

  it('does not join a short heading to the wider paragraph below it', () => {
    expect(canJoinTextBlock(
      [line('Overview', 20, 500, 55)],
      line('This paragraph continues across the column', 20, 486, 220),
      [],
    )).toBe(false);
  });

  it('joins full paragraph lines and their short last line', () => {
    const first = line('First full paragraph line', 20, 500, 210);
    const second = line('Second full paragraph line', 20, 486, 205);
    const last = line('Short ending', 20, 472, 80);
    expect(canJoinTextBlock([first], second, [])).toBe(true);
    expect(canJoinTextBlock([first, second], last, [])).toBe(true);
  });

  it('keeps a paragraph together when a sentence ends mid-line', () => {
    // Prose is full of sentences that end in the middle of a paragraph. A full stop on a
    // line that still runs to the text's right edge is not the end of the block.
    expect(canJoinTextBlock(
      [line('A sentence ends here.', 20, 500, 200)],
      line('and the paragraph carries on', 20, 486, 195),
      [],
    )).toBe(true);
  });

  it('ends the block when the sentence ends on a short line', () => {
    // A paragraph's last line stops short; that, not the full stop, ends the block.
    expect(canJoinTextBlock(
      [line('The end.', 20, 500, 60)],
      line('A new item starts here', 20, 486, 195),
      [],
    )).toBe(false);
  });
});

describe('block-local alignment', () => {
  it('detects left, right, and centre from a block’s own lines', () => {
    expect(detectBlockAlignment([
      line('One', 20, 500, 180),
      line('Two', 20.5, 486, 120),
    ])).toBe('left');
    expect(detectBlockAlignment([
      line('One', 20, 500, 180),
      line('Two', 80, 486, 120),
    ])).toBe('right');
    expect(detectBlockAlignment([
      line('One', 20, 500, 180),
      line('Two', 50, 486, 120),
    ])).toBe('center');
  });

  it('keeps a single line’s existing page-bound alignment', () => {
    expect(detectBlockAlignment([{ ...line('Date', 470, 500, 80), align: 'right' }]))
      .toBe('right');
  });
});
