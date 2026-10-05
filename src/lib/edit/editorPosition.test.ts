import { describe, expect, it } from 'vitest';
import type { TextEdit } from '@/lib/export/types';
import {
  baselineCorrectionPx,
  editorFirstLineOffsetPx,
  editorTopCorrection,
  freeTextBoxRect,
} from './editorPosition';

const style = {
  fontName: 'Helvetica',
  fontSizePt: 14,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
};

describe('editor positioning', () => {
  it('corrects only the measured baseline difference and clamps to one font size', () => {
    expect(baselineCorrectionPx(241.9, 127.9, 99, 114)).toBeCloseTo(15);
    expect(baselineCorrectionPx(100, 90, 12, 20)).toBe(-2);
    expect(baselineCorrectionPx(1000, 0, 10, 20)).toBe(20);
    expect(baselineCorrectionPx(-1000, 0, 10, 20)).toBe(-20);
  });

  it('does nothing without a finite measurement or commit baseline', () => {
    expect(baselineCorrectionPx(undefined, 100, 20, 20)).toBe(0);
    expect(baselineCorrectionPx(120, 100, undefined, 20)).toBe(0);
    expect(baselineCorrectionPx(120, 100, NaN, 20)).toBe(0);
    expect(baselineCorrectionPx(120, Infinity, 20, 20)).toBe(0);
    expect(baselineCorrectionPx(120, 100, 20, 0)).toBe(0);
  });
  it('keeps Task 44 ink correction on first open and removes it on re-open', () => {
    expect(editorTopCorrection(false, 12.1)).toBe(12.1);
    expect(editorTopCorrection(true, 12.1)).toBe(0);
  });

  it('cancels only the half-leading above the first line at every zoom', () => {
    expect(editorFirstLineOffsetPx(38.3, 31.92, 1)).toBeCloseTo(-3.19, 5);
    expect(editorFirstLineOffsetPx(38.3, 31.92, 1.5)).toBeCloseTo(-4.785, 5);
    expect(editorFirstLineOffsetPx(14, 14, 1.5)).toBe(0);
  });

  it('re-opens Add Text at the committed first line top', () => {
    const text: TextEdit = {
      id: 'free-line',
      kind: 'text',
      pageIndex: 0,
      rect: { x: 100, y: 226, w: 150, h: 14 },
      z: 1,
      text: 'Added text',
      style,
      origin: 'free',
      boxId: 'free-box',
      boxText: 'Added text',
      boxHeight: 36,
    };

    const box = freeTextBoxRect([text]);
    expect(box).toEqual({ x: 100, y: 204, w: 150, h: 36 });
    expect(box.y + box.h).toBe(text.rect.y + text.rect.h);
  });
});
