import { describe, expect, it } from 'vitest';
import type { TextBlock } from './textContent';
import type { CoverEdit, TextEdit } from '@/lib/export/types';
import { textPreviewSelection } from './textPreviewSelection';

const style = { fontName: 'Helvetica', fontSizePt: 12, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
const rect = { x: 20, y: 300, w: 100, h: 12 };
describe('re-editing retained source glyphs', () => {
  it('temporarily removes the retained glyphs, without changing the saved covers', () => {
    const block: TextBlock = { pageIndex: 0, text: 'one two', rect, topBaselineY: 300, lineHeightPt: 14, style, lines: [] };
    const cover: CoverEdit = { id: 'cover', kind: 'cover', pageIndex: 0, z: 1, rect, sampleBackground: true,
      replaces: [{ text: 'two', rect: { ...rect, x: 80 } }] };
    const edit: TextEdit = { id: 'edit', kind: 'text', pageIndex: 0, z: 2, rect, text: 'one two', style,
      composition: { version: 1, text: 'one two', style, alignment: 'left', alignmentLeftPt: 20, alignmentWidthPt: 100,
        pieces: [{ text: 'one', x: 20, baselineY: 300, widthPt: 20, style, sourceRect: rect, sourceVisible: true },
          { text: 'two', x: 80, baselineY: 300, widthPt: 20, style, sourceVisible: false }] } };
    const selection = textPreviewSelection(block, { covers: [cover], texts: [edit] });
    expect(selection.omitTextIds).toEqual(['edit']);
    expect(selection.coverIds).toEqual(['cover', selection.transientEdits[0]!.id]);
    expect((selection.transientEdits[0] as CoverEdit).replaces).toEqual([{ text: 'one', rect }]);
    expect(cover.replaces![0]!.text).toBe('two');
  });
});
