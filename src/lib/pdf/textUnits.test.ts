import { describe, expect, it } from 'vitest';
import type { TextStyle } from '@/lib/export/types';
import type { RuleLine } from './ruleLines';
import type { TextLine, TextRun } from './textContent';
import {
  canJoinTextBlock,
  canJoinTextBulletList,
  canJoinUniformTextBlock,
  detectBlockAlignment,
  intrinsicBold,
  paragraphWeight,
  firstWordWidthPt,
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

describe('evidenced paragraph wraps', () => {
  function bold(source: TextLine): TextLine {
    const next = { ...source.style, fontName: 'Helvetica-Bold', bold: true, sourceBold: true };
    return { ...source, style: next, runs: source.runs.map((run) => ({ ...run, style: next })) };
  }
  const upper = line('A paragraph continues with', 20, 500, 210);
  const lower = bold(line('Highlights:', 20, 486, 70));
  const peer = line('Another full-width paragraph', 20, 440, 250);
  const joins = (next = lower, previous = upper, peers = [upper, lower, peer]) => (
    canJoinTextBlock([previous], next, [], [], peers)
  );
  it('joins a wrapped bold phrase without changing its style', () => {
    expect(joins()).toBe(true);
    expect(lower.style.bold).toBe(true);
    expect(paragraphWeight(lower)).toBe('bold');
  });
  it('counts letters across fragmented runs; punctuation is not weight', () => {
    const mixed = { ...lower, runs: [run('regular text', 20, 40), ...lower.runs] };
    expect(paragraphWeight(mixed)).toBe('mixed');
    expect(paragraphWeight({ ...lower, runs: [run('...123', 20, 30), ...lower.runs] })).toBe('bold');
  });
  it('uses the first word’s own advances, not average character width', () => {
    const source = line('WWW i', 20, 486, 40);
    const own = { ...source, runs: [{ ...source.runs[0]!, characterWidthsPt: [10, 10, 10, 5, 5] }] };
    expect(firstWordWidthPt(own)).toBe(30);
    expect(firstWordWidthPt(line('WWW i', 20, 486, 40))).toBeUndefined();
  });
  it('requires a proven column and a word that cannot fit', () => {
    expect(joins(lower, upper, [upper])).toBe(false);
    expect(joins(bold(line('tiny', 20, 486, 20)))).toBe(false);
    expect(joins(lower, upper, [upper, line('Narrow peer', 20, 440, 190)])).toBe(false);
  });
  it.each(['• Breakfast', '-Wrote', '– x', '3:15 PM', '1. First', '2) Second', '100% refund after Friday', '© Copyright notice', 'Day 2'])('never newly joins an item: %s', (text) => {
    expect(joins(bold(line(text, 20, 486, 100)))).toBe(false);
  });
  it('does not override page, border, size, family or italic guards', () => {
    expect(joins({ ...lower, pageIndex: 1 })).toBe(false);
    expect(canJoinTextBlock([upper], lower, [rule('horizontal', 20, 493, 270, 493)], [], [upper, lower, peer])).toBe(false);
    expect(joins(bold(line('Highlights:', 20, 486, 70, 11)))).toBe(false);
    expect(joins({ ...lower, style: { ...lower.style, fontName: 'Times-Bold' } })).toBe(false);
    expect(joins({ ...lower, style: { ...lower.style, italic: true } })).toBe(false);
  });
  it('keeps same-weight new sentences apart but permits bold Highlights', () => {
    const ending = line('The sentence ends here.', 20, 500, 210);
    expect(joins(line('Competition continues across this wider line', 20, 486, 260), ending)).toBe(false);
    expect(joins(lower, ending)).toBe(true);
  });
});

describe('uniform text blocks', () => {
  const upper = line('Total questions: 108', 20, 500, 80);
  const lower = line('Total duration: 120 minutes (2 hours)', 20, 486, 220);
  it('ignores length and capitals for same-face fact lines and accepted plain subheadings', () => {
    expect(canJoinUniformTextBlock([upper], lower, [])).toBe(true);
    expect(canJoinUniformTextBlock([line('Accountability', 20, 500, 55)], lower, [])).toBe(true);
  });
  it.each(['• Breakfast', '-Wrote', '– x', '1. First', '2) Second', '5.1 Section', '1.10.2 Section', '(a) Board', '(iii) Board', '(2) Board', 'a. Board', 'iii. Board', '3:15 PM', '10.30 AM', 'Day 2', '100% refund', '© Notice', '203/-'])('does not newly absorb item %s on either side', (text) => {
    const item = line(text, 20, 500, 90);
    expect(canJoinUniformTextBlock([item], lower, [])).toBe(false);
    expect(canJoinUniformTextBlock([upper], { ...item, baselineY: 486 }, [])).toBe(false);
  });
  it('rejects size, weight, mixed emphasis, italic, family, page, indent and borders', () => {
    const variants = [
      { ...lower, style: { ...lower.style, fontSizePt: 11 } },
      { ...lower, style: { ...lower.style, italic: true } },
      { ...lower, style: { ...lower.style, fontName: 'Times' } },
      { ...lower, pageIndex: 1 },
      { ...lower, rect: { ...lower.rect, x: 23 } },
      { ...lower, runs: lower.runs.map((run) => ({ ...run, style: { ...run.style, bold: true } })) },
      { ...lower, runs: [...lower.runs, { ...run('bold label', 20, 40), style: { ...style, bold: true } }] },
    ];
    for (const variant of variants) expect(canJoinUniformTextBlock([upper], variant, [])).toBe(false);
    expect(canJoinUniformTextBlock([upper], lower, [rule('horizontal', 20, 493, 250, 493)])).toBe(false);
    expect(canJoinUniformTextBlock([upper], lower, [], [{ pageIndex: 0, rect: { x: 10, y: 487, w: 4, h: 4 } }])).toBe(false);
  });
  it('rejects extra spacing against the joined box’s established line gap', () => {
    const middle = line('Total marks: 360', 20, 486, 90);
    expect(canJoinUniformTextBlock([upper, middle], line('Sections: 3', 20, 472, 70), [])).toBe(true);
    expect(canJoinUniformTextBlock([upper, middle], line('Sections: 3', 20, 470, 70), [])).toBe(false);
  });
});

it('does not absorb rows of a borderless table with aligned parallel cells', () => {
  const upper = line('A short name', 20, 500, 80), lower = line('A considerably longer name', 20, 486, 220);
  const peers = [upper, lower, line('Role 1', 300, 500, 100), line('Role 2', 300, 486, 120)];
  expect(canJoinUniformTextBlock([upper], lower, [], [], peers)).toBe(false);
  expect(canJoinUniformTextBlock([upper], lower, [], [], peers.slice(0, 3))).toBe(false);
  expect(canJoinUniformTextBlock([upper], lower, [], [], [upper, lower])).toBe(true);
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
