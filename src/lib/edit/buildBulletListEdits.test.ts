import { describe, expect, it } from 'vitest';
import type { CoverEdit } from '@/lib/export/types';
import type { BulletList } from '@/lib/pdf/bulletList';
import type { TextBlock, TextLine } from '@/lib/pdf/textContent';
import { EMPTY_HISTORY, historyReducer } from '@/state/editsStore';
import {
  buildBulletListEdits,
  coverRectForBulletList,
} from './buildTextEdits';
import type { NextTextEdit } from './buildTextEdits';

const style = {
  fontName: 'Helvetica',
  fontSizePt: 10,
  bold: false,
  italic: false,
  color: { r: 0, g: 0, b: 0 },
} as const;

function line(text: string, baselineY: number): TextLine {
  return {
    pageIndex: 0,
    text,
    baselineY,
    rect: { x: 30, y: baselineY, w: 120, h: 10 },
    style,
    runs: [],
  };
}

function fixtureList(): BulletList {
  const lines = [line('First item', 100), line('Second item', 88)];
  const block: TextBlock = {
    pageIndex: 0,
    text: lines.map((entry) => entry.text).join('\n'),
    rect: { x: 30, y: 88, w: 120, h: 22 },
    topBaselineY: 100,
    lineHeightPt: 12,
    style,
    lines,
  };
  return {
    sourceBlock: block,
    block,
    items: [
      { bulletX: 20, baselineY: 100, text: 'First item', lines: [lines[0]!], markerRect: { x: 20, y: 102, w: 3, h: 3 } },
      { bulletX: 20, baselineY: 88, text: 'Second item', lines: [lines[1]!], markerRect: { x: 20, y: 90, w: 3, h: 3 } },
    ],
    bulletX: 20,
    textX: 30,
    bulletSizePt: 3,
    lineHeightPt: 12,
    itemSpacingPt: 0,
    coverRect: { x: 20, y: 88, w: 130, h: 25 },
  };
}

const next: NextTextEdit = {
  text: '• First item\n• Second item',
  style,
  width: 130,
  height: 22,
  dx: 0,
  dy: 0,
};

describe('buildBulletListEdits', () => {
  it('covers the painted marker strip and draws one aligned bullet per item', () => {
    const list = fixtureList();
    const built = buildBulletListEdits(
      list,
      next,
      [
        { text: 'First item', lines: ['First item'] },
        { text: 'Second item', lines: ['Second item'] },
      ],
      7,
      100,
    );

    expect(built.overflow).toBe(false);
    expect(built.covers).toHaveLength(1);
    expect(built.covers[0]?.rect).toEqual(coverRectForBulletList(list));
    expect(built.covers[0]?.rect.x).toBeLessThan(list.block.rect.x);
    const bullets = built.texts.filter((edit) => edit.text === '•');
    const bodies = built.texts.filter((edit) => edit.text !== '•');
    expect(bullets).toHaveLength(2);
    expect(bullets.map((edit) => edit.rect.x)).toEqual([20, 20]);
    expect(bullets.map((edit) => edit.rect.y)).toEqual(bodies.map((edit) => edit.rect.y));
  });

  it('adds approximately one line height for a new one-line item', () => {
    const list = fixtureList();
    const two = buildBulletListEdits(
      list,
      next,
      [{ text: 'One', lines: ['One'] }, { text: 'Two', lines: ['Two'] }],
      1,
      100,
    );
    const three = buildBulletListEdits(
      list,
      { ...next, text: `${next.text}\n• Third item` },
      [
        { text: 'One', lines: ['One'] },
        { text: 'Two', lines: ['Two'] },
        { text: 'Three', lines: ['Three'] },
      ],
      1,
      100,
    );

    expect(three.usedHeightPt - two.usedHeightPt).toBeCloseTo(12, 5);
  });

  it('returns a stop flag and no edits when the next section leaves no room', () => {
    const built = buildBulletListEdits(
      fixtureList(),
      next,
      [{ text: 'One', lines: ['One'] }, { text: 'Two', lines: ['Two'] }],
      1,
      15,
    );

    expect(built.overflow).toBe(true);
    expect(built.covers).toEqual([]);
    expect(built.texts).toEqual([]);
  });

  it('keeps an invisible re-edit anchor when every bullet is removed', () => {
    const built = buildBulletListEdits(
      fixtureList(),
      { ...next, text: '', height: 0 },
      [],
      1,
      100,
    );

    expect(built.overflow).toBe(false);
    expect(built.covers).toHaveLength(1);
    expect(built.texts).toHaveLength(1);
    expect(built.texts[0]).toMatchObject({ text: '', boxText: '', boxHeight: 0 });
  });

  it('stores the complete redraw as one undoable replace action', () => {
    const original: CoverEdit = {
      id: 'original',
      kind: 'cover',
      pageIndex: 0,
      rect: fixtureList().coverRect,
      z: 1,
      sampleBackground: true,
    };
    const before = historyReducer(EMPTY_HISTORY, { type: 'add', edits: [original] });
    const built = buildBulletListEdits(
      fixtureList(),
      next,
      [{ text: 'One', lines: ['One'] }, { text: 'Two', lines: ['Two'] }],
      2,
      100,
    );
    const changed = historyReducer(before, {
      type: 'replace',
      removeIds: [original.id],
      edits: [...built.covers, ...built.texts],
    });

    expect(changed.past).toHaveLength(before.past.length + 1);
    expect(historyReducer(changed, { type: 'undo' }).present).toEqual(before.present);
  });

  it('moves every bullet and line by dx/dy, leaving the cover in place', () => {
    const items = [
      { text: 'First item', lines: ['First item'] },
      { text: 'Second item', lines: ['Second item'] },
    ];
    const base = buildBulletListEdits(fixtureList(), next, items, 7, 100);
    const moved = buildBulletListEdits(fixtureList(), { ...next, dx: 5, dy: -8 }, items, 7, 100);

    expect(moved.covers[0]?.rect).toEqual(base.covers[0]?.rect);
    expect(moved.texts).toHaveLength(base.texts.length);
    moved.texts.forEach((edit, index) => {
      const original = base.texts[index]!;
      expect(edit.rect.x).toBeCloseTo(original.rect.x + 5, 5);
      expect(edit.rect.y).toBeCloseTo(original.rect.y - 8, 5);
    });
  });
});
