import { describe, expect, it } from 'vitest';
import type { TextRun } from '@/lib/pdf/textContent';
import type { TextBlock } from '@/lib/pdf/textContent';
import {
  buildFreeTextEdits,
  buildTextBlockEdits,
  buildTextEdits,
  coverRectForTextBlock,
  coverRectsForTextBlock,
  textBlockLineHeight,
} from './buildTextEdits';

const run: TextRun = {
  pageIndex: 2,
  text: 'Original',
  rect: { x: 40, y: 500, w: 120, h: 18 },
  style: {
    fontName: 'Helvetica',
    fontSizePt: 12,
    bold: false,
    italic: false,
    color: { r: 0, g: 0, b: 0 },
  },
};

describe('buildTextEdits', () => {
  it('builds standalone wrapped free text without cover edits', () => {
    const style = { ...run.style, fontSizePt: 14 };
    const edits = buildFreeTextEdits(
      3,
      { x: 100, y: 200, w: 160, h: 40 },
      { text: 'First second', style, width: 150, height: 36, dx: 5, dy: -2 },
      ['First', 'second'],
      20,
      'free-box-1',
    );

    expect(edits).toHaveLength(2);
    expect(edits.map((edit) => edit.kind)).toEqual(['text', 'text']);
    expect(edits.map((edit) => edit.rect)).toEqual([
      { x: 105, y: 238, w: 150, h: 14 },
      { x: 105, y: 221.2, w: 150, h: 14 },
    ]);
    expect(edits.map((edit) => edit.z)).toEqual([20, 21]);
    expect(edits.every((edit) => edit.origin === 'free' && edit.boxId === 'free-box-1')).toBe(true);
    expect(edits.every((edit) => edit.boxText === 'First second' && edit.boxHeight === 36)).toBe(true);
  });

  it('builds an original-size sampled cover below the replacement text', () => {
    const style = {
      ...run.style,
      fontSizePt: 14,
      bold: true,
      italic: true,
    };
    const result = buildTextEdits(
      run,
      { text: 'Replacement', style, width: 180, height: 24, dx: 0, dy: 0 },
      10,
    );

    expect(result.cover).toMatchObject({
      kind: 'cover',
      pageIndex: 2,
      rect: run.rect,
      z: 10,
      sampleBackground: true,
    });
    expect(result.text).toMatchObject({
      kind: 'text',
      pageIndex: 2,
      rect: { x: 40, y: 500, w: 180, h: 18 },
      z: 11,
      text: 'Replacement',
      style,
    });
    expect(result.cover.id).not.toBe(result.text.id);
    expect(result.text.boxText).toBe('Replacement');
    expect(result.text.boxHeight).toBe(24);
  });

  it('moves only the replacement text while the cover stays over the original glyphs', () => {
    const result = buildTextEdits(
      run,
      { text: 'Moved', style: run.style, width: 140, height: 18, dx: 24, dy: -12 },
      4,
    );

    expect(result.cover.rect).toEqual(run.rect);
    expect(result.text.rect).toEqual({ x: 64, y: 488, w: 140, h: 18 });
  });

  it('moves a re-edit relative to its current text rect', () => {
    const currentRect = { x: 80, y: 470, w: 150, h: 20 };
    const result = buildTextEdits(
      run,
      { text: 'Moved again', style: run.style, width: 175, height: 20, dx: -5, dy: 9 },
      8,
      currentRect,
    );

    expect(result.cover.rect).toEqual(run.rect);
    expect(result.text.rect).toEqual({ x: 75, y: 479, w: 175, h: 20 });
  });

  it('emits locally sampled line covers and selectable text edits on successive baselines', () => {
    const firstLine = {
      pageIndex: run.pageIndex,
      text: 'Line one',
      rect: { x: 40, y: 500, w: 70, h: 12 },
      baselineY: 500,
      style: run.style,
      runs: [],
    };
    const secondLine = {
      pageIndex: run.pageIndex,
      text: 'Line two',
      rect: { x: 40, y: 484, w: 64, h: 12 },
      baselineY: 484,
      style: run.style,
      runs: [],
    };
    const block: TextBlock = {
      pageIndex: run.pageIndex,
      text: 'Line one\nLine two',
      rect: { x: 40, y: 470, w: 180, h: 48 },
      topBaselineY: 500,
      lineHeightPt: 16,
      style: run.style,
      lines: [firstLine, secondLine],
    };
    const result = buildTextBlockEdits(
      block,
      { text: 'First second third', style: run.style, width: 160, height: 48, dx: 5, dy: -3 },
      ['First', 'second', 'third'],
      20,
    );

    expect(result.covers.map((edit) => edit.rect)).toEqual(coverRectsForTextBlock(block));
    expect(result.covers).toHaveLength(2);
    expect(result.covers.map((edit) => edit.z)).toEqual([20, 21]);
    expect(coverRectForTextBlock(block).w).toBeGreaterThanOrEqual(firstLine.rect.w);
    expect(result.texts.map((edit) => edit.text)).toEqual(['First', 'second', 'third']);
    expect(result.texts.map((edit) => edit.rect)).toEqual([
      { x: 45, y: 497, w: 160, h: 12 },
      { x: 45, y: 481, w: 160, h: 12 },
      { x: 45, y: 465, w: 160, h: 12 },
    ]);
    expect(result.texts.map((edit) => edit.z)).toEqual([22, 23, 24]);
    expect(result.texts.every((edit) => edit.boxHeight === 48)).toBe(true);
    expect(result.texts.every((edit) => edit.boxText === 'First second third')).toBe(true);
  });

  it('keeps the user-selected font size and box dimensions authoritative', () => {
    const block: TextBlock = {
      pageIndex: run.pageIndex,
      text: 'Original',
      rect: { x: 40, y: 470, w: 180, h: 48 },
      topBaselineY: 500,
      lineHeightPt: 16,
      style: run.style,
      lines: [],
    };
    const manualStyle = { ...run.style, fontSizePt: 18 };
    const result = buildTextBlockEdits(
      block,
      { text: 'Larger', style: manualStyle, width: 240, height: 72, dx: 0, dy: 0 },
      ['Larger'],
      30,
    );

    expect(result.texts[0]).toMatchObject({
      rect: { w: 240, h: 18 },
      style: { fontSizePt: 18 },
      boxText: 'Larger',
      boxHeight: 72,
    });
  });

  it('emits per-line rich spans and retains the unwrapped spans for re-editing', () => {
    const block: TextBlock = {
      pageIndex: run.pageIndex,
      text: 'Original',
      rect: { x: 40, y: 470, w: 180, h: 48 },
      topBaselineY: 500,
      lineHeightPt: 16,
      style: run.style,
      lines: [],
    };
    const boxSpans = [
      { text: 'Plain ', bold: false, italic: false },
      { text: 'boldword', bold: true, italic: false },
    ];
    const result = buildTextBlockEdits(
      block,
      { text: 'Plain boldword', spans: boxSpans, style: run.style, width: 60, height: 40, dx: 0, dy: 0 },
      [
        { text: 'Plain ', spans: [boxSpans[0]!] },
        { text: 'bold', spans: [{ text: 'bold', bold: true, italic: false }] },
        { text: 'word', spans: [{ text: 'word', bold: true, italic: false }] },
      ],
      40,
    );

    expect(result.texts.map((edit) => edit.spans)).toEqual([
      [{ text: 'Plain ', bold: false, italic: false }],
      [{ text: 'bold', bold: true, italic: false }],
      [{ text: 'word', bold: true, italic: false }],
    ]);
    expect(result.texts.every((edit) => edit.boxSpans === boxSpans)).toBe(true);
    expect(result.texts.map((edit) => edit.text)).toEqual(['Plain ', 'bold', 'word']);
  });

  it('uses a natural shared line height and emits no undeletable blank text line', () => {
    const block: TextBlock = {
      pageIndex: run.pageIndex,
      text: '1',
      rect: { x: 40, y: 500, w: 12, h: 12 },
      topBaselineY: 500,
      lineHeightPt: 40,
      style: run.style,
      lines: [],
    };

    expect(textBlockLineHeight(block, run.style)).toBeCloseTo(16.2, 5);
    const result = buildTextBlockEdits(
      block,
      { text: '', style: run.style, width: 12, height: 12, dx: 0, dy: 0 },
      [],
      30,
    );
    expect(result.covers).toHaveLength(1);
    expect(result.texts).toEqual([]);
  });
});
