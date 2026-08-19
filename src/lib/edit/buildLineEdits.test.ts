import { describe, expect, it } from 'vitest';
import type { RuleLine } from '@/lib/pdf/ruleLines';
import {
  buildLineDelete,
  buildLineMove,
  coverRectForRuleLine,
} from './buildLineEdits';

const source: RuleLine = {
  pageIndex: 0,
  orientation: 'horizontal',
  x1: 10,
  y1: 50,
  x2: 110,
  y2: 50,
  thicknessPt: 2,
  color: { r: 0.1, g: 0.2, b: 0.3 },
};

describe('line edit builders', () => {
  it('moves with one padded cover at the original and one translated line', () => {
    const built = buildLineMove(source, 5, -3, 20);

    expect(built.cover).toEqual(expect.objectContaining({
      kind: 'cover',
      pageIndex: 0,
      rect: { x: 7.5, y: 47.5, w: 105, h: 5 },
      z: 20,
      sampleBackground: true,
    }));
    expect(built.line).toEqual(expect.objectContaining({
      kind: 'line',
      pageIndex: 0,
      x1: 15,
      y1: 47,
      x2: 115,
      y2: 47,
      thicknessPt: 2,
      color: source.color,
      rect: { x: 14, y: 46, w: 102, h: 2 },
      z: 21,
    }));
  });

  it('deletes with only the original padded cover', () => {
    const built = buildLineDelete(source, 8);

    expect(Object.keys(built)).toEqual(['cover']);
    expect(built.cover.rect).toEqual(coverRectForRuleLine(source));
    expect(built.cover.z).toBe(8);
  });
});
