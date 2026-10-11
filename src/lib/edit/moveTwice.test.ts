import { describe, expect, it } from 'vitest';
import type { TextEdit } from '@/lib/export/types';
import type { TextBlock, TextLine } from '@/lib/pdf/textContent';
import { buildTextBlockEdits } from './buildTextEdits';
import type { NextTextEdit } from './buildTextEdits';

const style = { fontName: 'Helvetica', fontSizePt: 10, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };

function line(text: string, baselineY: number, x = 40, width = 200): TextLine {
  const rect = { x, y: baselineY, w: width, h: 10 };
  return { pageIndex: 0, text, baselineY, rect, style, runs: [{ pageIndex: 0, text, rect, style }] };
}
function block(lines: TextLine[], extra: Partial<TextBlock> = {}): TextBlock {
  const x = Math.min(...lines.map((item) => item.rect.x));
  return {
    pageIndex: 0, text: lines.map((item) => item.text).join('\n'), lines, style, lineHeightPt: 12,
    rect: { x, y: lines.at(-1)!.baselineY, w: 200, h: 12 * lines.length }, topBaselineY: lines[0]!.baselineY, ...extra,
  };
}

/** Done once with a move, then reopen the saved edit and Done again with another move. */
function moveTwice(source: TextBlock, next: NextTextEdit, wrapped: Parameters<typeof buildTextBlockEdits>[2]) {
  const first = buildTextBlockEdits(source, next, wrapped, 1).texts;
  // What OverlayLayer passes when the saved edit is reopened.
  const base = { x: Math.min(...first.map((edit) => edit.rect.x)), topBaselineY: Math.max(...first.map((edit) => edit.rect.y)) };
  const current = first.map((edit) => ({ text: edit.text, x: edit.rect.x, y: edit.rect.y, width: edit.rect.w }));
  const reopened: NextTextEdit = {
    ...next,
    ...(first[0]!.align ? { alignLeftPt: first[0]!.alignLeftPt, alignWidthPt: first[0]!.alignWidthPt } : {}),
  };
  const second = buildTextBlockEdits(source, reopened, wrapped, 10, base, current).texts;
  return { first, second };
}
const where = (texts: readonly TextEdit[]) => texts.map((edit) => [edit.rect.x, edit.rect.y]);

describe('moving a box a second time adds to the first move', () => {
  it('a heading', () => {
    const source = block([line('UTKARSH TANEJA', 700)]);
    const { first, second } = moveTwice(source, { text: 'UTKARSH TANEJA', style, width: 200, height: 12, dx: 10, dy: -8 }, ['UTKARSH TANEJA']);
    expect(where(first)).toEqual([[50, 692]]);
    expect(where(second)).toEqual([[60, 684]]);
  });

  it('a centred title', () => {
    const title = { ...line('Green Technologies', 456.67, 192.1, 323.8), alignLeftPt: 192.1, alignWidthPt: 323.8 };
    const source = block([title], { align: 'center', alignLeftPt: 192.1, alignWidthPt: 323.8 });
    const next: NextTextEdit = { text: 'Green Technologies', style, width: 323.8, height: 12, dx: 26, dy: 0,
      align: 'center', alignLeftPt: 192.1, alignWidthPt: 323.8 };
    const { first, second } = moveTwice(source, next, ['Green Technologies']);
    expect(first[0]!.rect.x).toBeCloseTo(218.1, 6);
    expect(second[0]!.rect.x).toBeCloseTo(244.1, 6);
  });

  it('a multi-line paragraph, every line', () => {
    const lines = [line('Explore the culture and', 700), line('landscapes from the', 687.6), line('monasteries.', 676, 40, 60)];
    const source = block(lines, { paragraphLineHeightPt: 12 });
    const next: NextTextEdit = { text: 'Explore the culture and landscapes from the monasteries.', style, width: 200, height: 40,
      dx: 0, dy: -13, paragraphs: [{ gapBeforePt: 0, firstIndentPt: 0, restIndentPt: 0 }] };
    const wrapped = lines.map((item, index) => ({ text: item.text, paragraphIndex: 0, paragraphStart: index === 0 }));
    const { first, second } = moveTwice(source, next, wrapped);
    expect(first.map((edit) => edit.rect.y)).toEqual([687, 674.6, 663].map((y) => expect.closeTo(y, 6)));
    expect(second.map((edit) => edit.rect.y)).toEqual([674, 661.6, 650].map((y) => expect.closeTo(y, 6)));
  });

  it('Done without a move leaves a moved box exactly where it is', () => {
    const source = block([line('UTKARSH TANEJA', 700)]);
    const { first, second } = moveTwice(source, { text: 'UTKARSH TANEJA', style, width: 200, height: 12, dx: 0, dy: 0 }, ['UTKARSH TANEJA']);
    expect(where(second)).toEqual(where(first));
  });
});
