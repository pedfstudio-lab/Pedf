import { describe, expect, it } from 'vitest';
import type { TextLine, TextRun } from './textContent';
import { preserveEditedBlockPartitions, textBlockFromLines } from './textContent';
import { pageLinePitches } from './paragraphPitch';
import { canJoinTextBlock, fontFamily } from './textUnits';

const style = { fontName: 'Helvetica', fontSizePt: 10, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };

function line(text: string, baselineY: number, x = 40, width = 200, lineStyle = style): TextLine {
  const rect = { x, y: baselineY, w: width, h: lineStyle.fontSizePt };
  return { pageIndex: 0, text, baselineY, rect, style: lineStyle, runs: [{ pageIndex: 0, text, rect, style: lineStyle }] };
}

describe('reopening an edited box keeps the pitch its first edit used', () => {
  it('keeps the current block when the saved box is the same lines', () => {
    const current = { ...textBlockFromLines([line('One', 700), line('Two', 682)]), paragraphLineHeightPt: 12 };
    const savedCopy = textBlockFromLines([line('One', 700), line('Two', 682)]);
    const [block] = preserveEditedBlockPartitions([current], [savedCopy], () => true);
    expect(block).toBe(current);
  });

  it('gives a larger saved box the page pitch of the block it starts in', () => {
    const upper = { ...textBlockFromLines([line('One', 700), line('Two', 682)]), paragraphLineHeightPt: 12 };
    const lower = { ...textBlockFromLines([line('Three', 664)]), paragraphLineHeightPt: 12 };
    const saved = textBlockFromLines([line('One', 700), line('Two', 682), line('Three', 664)]);
    const blocks = preserveEditedBlockPartitions([upper, lower], [saved], () => true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.lines.map((item) => item.text)).toEqual(['One', 'Two', 'Three']);
    expect(blocks[0]!.paragraphLineHeightPt).toBe(12);
  });
});

/** The pre-fix implementation: every line compared with every other line. */
function referencePitches(lines: readonly TextLine[]): Map<TextLine, number> {
  const key = (item: TextLine) => `${item.pageIndex}:${fontFamily(item.style.fontName)}:${Math.round(item.style.fontSizePt * 10)}`;
  const samples = new Map<string, number[]>();
  for (const item of lines) {
    const previous = lines.filter((other) => key(other) === key(item)
      && other.baselineY - item.baselineY > 0.5
      && other.baselineY - item.baselineY <= item.style.fontSizePt * 1.85
      && Math.min(other.rect.x + other.rect.w, item.rect.x + item.rect.w) > Math.max(other.rect.x, item.rect.x))
      .sort((a, b) => a.baselineY - b.baselineY)[0];
    if (!previous) continue;
    const group = samples.get(key(item)) ?? [];
    group.push(previous.baselineY - item.baselineY); samples.set(key(item), group);
  }
  const modes = new Map<string, number>();
  for (const [name, gaps] of samples) {
    const buckets = new Map<number, number[]>();
    for (const gap of gaps) {
      const bucket = Math.round(gap * 2), values = buckets.get(bucket) ?? [];
      values.push(gap); buckets.set(bucket, values);
    }
    const best = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0]?.[1];
    if (!best || best.length < 2) continue;
    modes.set(name, best.reduce((a, b) => a + b, 0) / best.length);
  }
  return new Map(lines.flatMap((item) => {
    const pitch = modes.get(key(item)); return pitch === undefined ? [] : [[item, pitch] as const];
  }));
}

describe('page line pitch', () => {
  it('finds the same pitches as comparing every pair, on a crowded two-face page', () => {
    let seed = 7;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const faces = [style, { ...style, fontName: 'Times-Roman' }, { ...style, fontSizePt: 12 }];
    const lines: TextLine[] = [];
    for (let column = 0; column < 6; column += 1) {
      const face = faces[column % faces.length]!;
      const pitch = face.fontSizePt * (1.15 + 0.05 * (column % 3));
      for (let row = 0; row < 60; row += 1) {
        const y = 760 - row * pitch + (random() < 0.2 ? random() * 6 : 0);
        lines.push(line(`c${column}r${row}`, Math.round(y * 100) / 100, 30 + column * 90 + random() * 20, 40 + random() * 120, face));
      }
    }
    const expected = referencePitches(lines);
    const actual = pageLinePitches(lines);
    expect(actual.size).toBe(expected.size);
    expect(actual.size).toBeGreaterThan(300);
    for (const [item, pitch] of expected) expect(actual.get(item)).toBe(pitch);
  });
});

describe('a typed bullet that shares its run with the item’s words', () => {
  // "• " is 7.5pt wide; the words start right after it.
  const text = '• Item text ends here.';
  const widths = [...text].map((character, index) => (index === 0 ? 5 : character === ' ' ? 2.5 : 5));
  const rect = { x: 40, y: 700, w: widths.reduce((a, b) => a + b, 0), h: 10 };
  const run: TextRun = { pageIndex: 0, text, rect, style, characterWidthsPt: widths, spaceWidthPt: 2.5 };
  const item: TextLine = { pageIndex: 0, text, baselineY: 700, rect, style, runs: [run] };

  it('does not take a margin note level with the dot into the item', () => {
    expect(canJoinTextBlock([item], line('Note: margin', 688, 40, 60), [])).toBe(false);
  });

  it('still joins a wrapped line under the item’s words', () => {
    expect(canJoinTextBlock([item], line('continues the item', 688, 47.5, 90), [])).toBe(true);
  });
});
