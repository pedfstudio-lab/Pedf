import { describe, expect, it } from 'vitest';
import type { TextBlock, TextLine, TextRun } from '@/lib/pdf/textContent';
import { canJoinFillerTextBlock, canJoinTextBlock } from '@/lib/pdf/textUnits';
import { paragraphSeedText } from './paragraphSeed';
import { sourceSpansForTextBlock } from './richText';

const style = { fontName: 'Helvetica', fontSizePt: 12, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
function line(text: string, y: number, width: number, x = 40, bold = false): TextLine {
  const run: TextRun = { pageIndex: 0, text, rect: { x, y, w: width, h: 12 }, style: { ...style, bold },
    characterWidthsPt: [...text].map(() => width / [...text].length), spaceWidthPt: 3 };
  return { pageIndex: 0, text, baselineY: y, rect: run.rect, style: run.style, runs: [run] };
}
function block(lines: TextLine[], width = 200): TextBlock {
  return { pageIndex: 0, text: lines.map(l => l.text).join('\n'), lines, style, rect: { x: 40, y: 600, w: width, h: 100 }, topBaselineY: 700, lineHeightPt: 16 };
}

describe('Change 7 spacing-led non-list joins', () => {
  it('joins different weights, italic, short lines, items and indents', () => {
    const upper = line('Heading', 700, 100, 40, true);
    for (const text of ['Body paragraph', '1. Numbered item', '- Dash item', '3:15 PM', 'Day 2']) {
      const lower = line(text, 684, 160, 58);
      expect(canJoinFillerTextBlock([upper], { ...lower, style: { ...lower.style, italic: true } }, [])).toBe(true);
    }
  });
  it('keeps different columns, sizes, families, larger gaps, numbers and bullets apart', () => {
    const upper = line('Left column', 700, 150);
    expect(canJoinFillerTextBlock([upper], line('Right column', 684, 150, 300), [])).toBe(false);
    expect(canJoinFillerTextBlock([upper], line('123', 684, 25), [])).toBe(false);
    expect(canJoinFillerTextBlock([upper], line('• Item', 684, 120), [])).toBe(false);
    expect(canJoinFillerTextBlock([upper], { ...line('Subtitle', 684, 160), style: { ...style, fontSizePt: 18 } }, [])).toBe(false);
    expect(canJoinFillerTextBlock([upper], { ...line('Serif', 684, 160), style: { ...style, fontName: 'Times Roman' } }, [])).toBe(false);
    expect(canJoinFillerTextBlock([upper, line('Second', 684, 140)], line('New paragraph', 658, 160), [])).toBe(false);
  });
});

describe('Change 8 per-line breaks and mixed rich spans', () => {
  it('keeps a short all-caps bold label separate even when its value is only slightly wider', () => {
    const value = block([line('GUEST NAME', 700, 70, 40, true), line('Mr. Pratik Sharma', 684, 84)], 84);
    expect(paragraphSeedText(value)).toBe(value.text);
  });
  it('keeps facts hard and a full sentence soft, with bold and color intact', () => {
    const facts = block([line('Total questions: 108', 700, 90), line('Total marks: 360', 684, 75), line('Total duration: 120 minutes', 668, 130)]);
    expect(paragraphSeedText(facts)).toBe(facts.text);
    const value = block([line('Heading', 700, 50, 40, true), line('A sentence reaching the edge', 684, 195),
      line('wraps here', 668, 65)]);
    const seed = paragraphSeedText(value);
    expect(seed).toBe('Heading\nA sentence reaching the edge wraps here');
    const spans = sourceSpansForTextBlock(value, seed)!;
    expect(spans).toBeDefined();
    expect(spans.map(span => span.text).join('')).toBe(seed);
    expect(spans.filter(span => span.bold).map(span => span.text).join('')).toContain('Heading');
    expect(sourceSpansForTextBlock(value, seed.replace('sentence', 'alien'))).toBeUndefined();
  });
  it('dehyphenates only a proven soft break and carries the following style', () => {
    const value = block([line('Postgra-', 700, 200), line('duate', 684, 30, 40, true)]);
    const seed = paragraphSeedText(value);
    expect(seed).toBe('Postgraduate');
    const spans = sourceSpansForTextBlock(value, seed)!;
    expect(spans.map(span => span.text).join('')).toBe(seed);
    expect(spans.filter(span => span.bold).map(span => span.text).join('')).toBe('duate');
    const short = block([line('Postgra-', 700, 50), line('duate', 684, 30)]);
    expect(paragraphSeedText(short)).toBe('Postgra-\nduate');
  });
  it('keeps display lines for center/right and fails closed on unknown partial glyph widths', () => {
    const value = block([line('First', 700, 180), line('Next word', 684, 150)]);
    expect(paragraphSeedText({ ...value, align: 'center' })).toBe(value.text);
    expect(paragraphSeedText({ ...value, align: 'right' })).toBe(value.text);
    const unknown = { ...value, lines: value.lines.map(l => ({ ...l, runs: l.runs.map(r => ({ ...r, characterWidthsPt: undefined })) })) };
    expect(paragraphSeedText(unknown)).toBe(value.text);
  });
});

describe('Change 9 bullet continuation edge', () => {
  it('detaches notes left of a drawn/picture bullet but keeps slightly outdented wraps', () => {
    const item = line('Bullet item', 700, 180, 56);
    const markers = [{ pageIndex: 0, rect: { x: 43, y: 702, w: 4, h: 4 } }];
    expect(canJoinTextBlock([item], line('Note at margin', 684, 180, 40), [], markers)).toBe(false);
    expect(canJoinTextBlock([item], line('Genuine wrap', 684, 180, 48), [], markers)).toBe(true);
    const wrap = line('Genuine wrap', 684, 180, 48);
    expect(canJoinTextBlock([item, wrap], line('Note after wrapped item', 668, 180, 40), [], markers)).toBe(false);
  });
  it('uses the right edge of a dedicated typed marker', () => {
    const marker = line('•', 700, 4, 40).runs[0]!;
    const body = line('Item', 700, 150, 50);
    const item = { ...body, text: '• Item', rect: { ...body.rect, x: 40, w: 160 }, runs: [marker, ...body.runs] };
    expect(canJoinTextBlock([item], line('Margin note', 684, 170, 40), [])).toBe(false);
    expect(canJoinTextBlock([item], line('Wrapped body', 684, 170, 45), [])).toBe(true);
  });
  it('preserves measured hanging wraps at the marker left edge, not a new uppercase note', () => {
    const marker = line('•', 700, 4, 40).runs[0]!;
    const body = line('Visit the temple &', 700, 150, 50);
    const item = { ...body, text: '• Visit the temple &', rect: { ...body.rect, x: 40, w: 160 }, runs: [marker, ...body.runs] };
    expect(canJoinTextBlock([item], line('Hapoli Market.', 684, 170, 40), [])).toBe(true);
    const closed = { ...item, text: '• Completed item.' };
    expect(canJoinTextBlock([closed], line('New note', 684, 170, 40), [])).toBe(false);
  });
});
