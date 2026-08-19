import { describe, expect, it, vi } from 'vitest';
import type { PageExportContext } from '../context';
import type { LineEdit } from '../types';
import { drawLine } from './line';

describe('drawLine', () => {
  it('draws the exact endpoints, thickness, and color', () => {
    const draw = vi.fn();
    const context = { page: { drawLine: draw } } as unknown as PageExportContext;
    const edit: LineEdit = {
      id: 'line-1',
      kind: 'line',
      pageIndex: 0,
      rect: { x: 10, y: 19.5, w: 100, h: 1 },
      z: 2,
      x1: 10,
      y1: 20,
      x2: 110,
      y2: 20,
      thicknessPt: 1,
      color: { r: 0.1, g: 0.2, b: 0.3 },
    };

    drawLine(edit, context);

    expect(draw).toHaveBeenCalledWith({
      start: { x: 10, y: 20 },
      end: { x: 110, y: 20 },
      thickness: 1,
      color: expect.objectContaining({ red: 0.1, green: 0.2, blue: 0.3 }),
    });
  });
});
