import { describe, expect, it } from 'vitest';
import type { TextStyle } from '@/lib/export/types';
import type { TextBlock, TextLine } from './textContent';
import { justifiedBlock } from './justification';

const style: TextStyle = { fontName: 'Helvetica', fontSizePt: 10, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
function fixture(texts = ['one two three four', 'five six seven eight', 'end']): TextBlock {
  const lines: TextLine[] = texts.map((text, index) => {
    const rect = { x: 20, y: 700 - index * 12, w: index === texts.length - 1 ? 30 : 100, h: 10 };
    return { pageIndex: 0, text, rect, baselineY: rect.y, style, runs: [{ pageIndex: 0, text, rect, style, spaceWidthPt: 5,
      characterWidthsPt: [...text].map(() => 5), wordSpacing: { normalSpacePt: 5, charSpacingPt: 0, unmeasured: 0,
        spaces: [...text.matchAll(/ /gu)].map(() => ({ left: 'a', right: 'b', gapPt: 7, normalSpacePt: 5, excessPt: 2 })) } }] };
  });
  return { pageIndex: 0, text: texts.join('\n'), style, align: 'left', lines, rect: { x: 20, y: lines.at(-1)!.rect.y, w: 100, h: texts.length * 12 }, topBaselineY: 700, lineHeightPt: 12 };
}

describe('approved conservative justification detector', () => {
  it('requires two non-final lines and enough positive measured gaps', () => {
    expect(justifiedBlock(fixture(), []).align).toBe('justify');
    const short = fixture(['one two three four', 'end']);
    expect(justifiedBlock(short, [])).toBe(short);
  });

  it('ignores unknown gaps rather than treating them as positive evidence', () => {
    const block = fixture();
    const unknown = { ...block, lines: block.lines.map(line => ({ ...line, runs: line.runs.map(run => ({ ...run, wordSpacing: undefined })) })) };
    expect(justifiedBlock(unknown, [])).toBe(unknown);
  });

  it('does not reclassify ragged, bullet, centred or right-aligned boxes', () => {
    const block = fixture();
    for (const align of ['center', 'right'] as const) {
      const aligned = { ...block, align };
      expect(justifiedBlock(aligned, [])).toBe(aligned);
    }
    const bullet = fixture(['• one two three four', 'five six seven eight', 'end']);
    expect(justifiedBlock(bullet, [])).toBe(bullet);
    const ragged = { ...block, lines: block.lines.map((line, index) => index === 1 ? { ...line, rect: { ...line.rect, w: 90 } } : line) };
    expect(justifiedBlock(ragged, [])).toBe(ragged);
  });

  it('records a squeeze limit only where that paragraph really narrowed a gap', () => {
    expect(justifiedBlock(fixture(), []).paragraphMinimumWordGapsEm).toEqual([undefined]);
    const block = fixture();
    const narrowed = { ...block, lines: block.lines.map((line, index) => index === 2 ? { ...line, runs: line.runs.map(run => ({ ...run,
      wordSpacing: { normalSpacePt: 5, charSpacingPt: 0, unmeasured: 0, spaces: [{ left: 'a', right: 'b', gapPt: 2, normalSpacePt: 5, excessPt: -3 }] } })) } : line) };
    expect(justifiedBlock(narrowed, []).paragraphMinimumWordGapsEm).toEqual([0.2]);
  });
});
