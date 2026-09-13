import { describe, expect, it } from 'vitest';
import type { TextEdit } from '@/lib/export/types';
import {
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
