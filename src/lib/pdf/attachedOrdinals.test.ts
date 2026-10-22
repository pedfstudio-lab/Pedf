import { describe, expect, it } from 'vitest';
import type { TextBlock, TextRun } from './textContent';
import { attachedOrdinals, hasInlineOrdinal, ordinalRemovalCovers } from './attachedOrdinals';
import { sourceSpansForTextBlock } from '@/lib/edit/richText';
import { buildTextBlockEdits } from '@/lib/edit/buildTextEdits';

const style = { fontName: 'Helvetica', fontSizePt: 20, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
const body: TextRun = { pageIndex: 0, text: '23', rect: { x: 10, y: 100, w: 20, h: 20 }, style };
const ordinal: TextRun = { pageIndex: 0, text: 'rd', rect: { x: 30, y: 108, w: 10, h: 12 },
  style: { ...style, fontSizePt: 12, fontName: 'Times-Italic', italic: true, color: { r: 1, g: 0, b: 0 } } };
function block(runs: readonly TextRun[], text = runs.map(run => run.text).join(' ')): TextBlock {
  const x = Math.min(...runs.map(run => run.rect.x)), y = Math.min(...runs.map(run => run.rect.y));
  const rect = { x, y, w: Math.max(...runs.map(run => run.rect.x + run.rect.w)) - x, h: Math.max(...runs.map(run => run.rect.y + run.rect.h)) - y };
  return { pageIndex: 0, text, rect, style: runs[0]!.style, topBaselineY: y, lineHeightPt: 24,
    lines: [{ pageIndex: 0, text, rect, baselineY: y, style: runs[0]!.style, runs }] };
}

describe('date ordinal attachment is editor-local', () => {
  it('inserts a smaller ordinal without losing its font, weight or colour, and never mutates the page blocks', () => {
    const date = block([body, { ...body, text: 'September', rect: { ...body.rect, x: 45, w: 100 } }]);
    const source = [date, block([ordinal])], before = JSON.stringify(source);
    const plan = attachedOrdinals(source)[0]!;
    expect(plan.source).toBe(date);
    expect(plan.editor.text).toBe('23rd September');
    expect(plan.editor.lines[0]!.runs.every(run => run.rect.y === date.topBaselineY && !run.metrics)).toBe(true);
    expect(sourceSpansForTextBlock(plan.editor)).toContainEqual(expect.objectContaining({ text: 'rd', fontSizePt: 12,
      fontName: 'Times-Italic', italic: true, color: ordinal.style.color }));
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each(['st', 'nd', 'rd', 'th', 'ST', 'TH'])('accepts only the exact ordinal piece %s', text => {
    expect(attachedOrdinals([block([body]), block([{ ...ordinal, text }])])[0]?.editor.text).toBe('23' + text);
  });

  it.each(['1', '¹', '®', '™', '²', 'first', 'the', 'rd note'])('leaves other raised pieces alone: %s', text => {
    expect(attachedOrdinals([block([body]), block([{ ...ordinal, text }])])).toEqual([]);
  });

  it.each([
    { ...ordinal, style: { ...ordinal.style, fontSizePt: 17 } },
    { ...ordinal, rect: { ...ordinal.rect, y: 100 } },
    { ...ordinal, rect: { ...ordinal.rect, y: 140 } },
    { ...ordinal, rect: { ...ordinal.rect, x: 60 } },
    { ...ordinal, pageIndex: 1 },
  ])('rejects a piece without the full size/rise/gap/page evidence', run => {
    expect(attachedOrdinals([block([body]), block([run])])).toEqual([]);
  });

  it.each(['ABC', 'm2', '23.'])('requires a number immediately to the left, not %s', text => {
    expect(attachedOrdinals([block([{ ...body, text }]), block([ordinal])])).toEqual([]);
  });

  it('deduplicates shadow paint in the editor but targets every original copy for removal, keeping the cover transaction', () => {
    const shadow = { ...ordinal, rect: { ...ordinal.rect, x: 31, y: 107 }, style: { ...ordinal.style, color: style.color } };
    const date = block([body]), tiny = block([shadow, ordinal], 'rdrd');
    const plan = attachedOrdinals([date, tiny], [body, shadow, ordinal])[0]!;
    expect(plan.editor.text).toBe('23rd'); expect(plan.ordinals[0]!.copies).toHaveLength(2);
    expect(plan.ordinals[0]!.run).toBe(ordinal);
    const covers = buildTextBlockEdits(date, { text: '24th', style, width: 100, height: 20, dx: 0, dy: 0 }, [], 7).covers;
    const removal = ordinalRemovalCovers(plan, covers);
    expect(removal).toHaveLength(covers.length);
    expect(removal[0]).toMatchObject({ id: covers[0]!.id, rect: covers[0]!.rect, z: 7 });
    expect(removal[0]!.replaces).toHaveLength(3);
    expect(removal[0]!.replaces).toContainEqual({ text: 'rd', rect: ordinal.rect });
    expect(removal[0]!.replaces).toContainEqual({ text: 'rd', rect: shadow.rect });
  });

  it('does not attach an already inline ordinal again; only recognizes its size-control behavior', () => {
    const inline = { ...ordinal, rect: { ...ordinal.rect, y: 100 } };
    const date = block([body, inline], '23rd');
    expect(attachedOrdinals([date])).toEqual([]);
    expect(hasInlineOrdinal(date)).toBe(true);
    expect(hasInlineOrdinal(block([body, ordinal], '23rd'))).toBe(false);
  });

  it('keeps stationary source-visible rows while removing the changed date and its raised ordinal', () => {
    const stationary = { ...body, text: '(Including GST)', rect: { ...body.rect, y: 76, w: 120 } };
    const date = block([body]);
    const row = block([stationary]).lines[0]!;
    const owner = { ...date, lines: [...date.lines, row], text: '23\n(Including GST)' };
    const plan = attachedOrdinals([owner, block([ordinal])])[0]!;
    const built = buildTextBlockEdits(owner, { text: '24th\n(Including GST)', style, width: 140,
      height: 48, dx: 0, dy: 0 }, [], 7);
    const texts = [{ ...built.texts[0]!, composition: { version: 1 as const,
      text: stationary.text, alignment: 'left' as const, alignmentLeftPt: 10, alignmentWidthPt: 140, style,
      pieces: [{ text: stationary.text, sourceRect: stationary.rect, sourceVisible: true,
        style: stationary.style, x: 10, baselineY: 76, widthPt: 120 }] } }];
    const removal = ordinalRemovalCovers(plan, built.covers, texts);
    expect(removal[0]!.replaces).toContainEqual({ text: body.text, rect: body.rect });
    expect(removal[0]!.replaces).toContainEqual({ text: ordinal.text, rect: ordinal.rect });
    expect(removal[0]!.replaces).not.toContainEqual({ text: stationary.text, rect: stationary.rect });
  });
});
