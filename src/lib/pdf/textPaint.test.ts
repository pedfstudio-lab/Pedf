import { OPS } from 'pdfjs-dist';
import { describe, expect, it } from 'vitest';
import { resolveTextPaint, textPaintByOperator, textPaintForItems } from './textPaint';

function shown(text: string) {
  return [[...text].map((unicode) => ({ unicode }))];
}

describe('textPaintByOperator', () => {
  it('tracks RGB, Gray and CMYK fill colours with save and restore', () => {
    const states = textPaintByOperator({
      fnArray: [
        OPS.setFillRGBColor, OPS.showText, OPS.save, OPS.setFillGray, OPS.showText,
        OPS.restore, OPS.setFillCMYKColor, OPS.showText,
      ],
      argsArray: [
        new Uint8ClampedArray([255, 128, 0]), shown('A'), null, [0.25], shown('B'),
        null, [1, 0, 0, 0], shown('C'),
      ],
    });

    expect(states.get(1)).toMatchObject({ color: { r: 1, g: 128 / 255, b: 0 }, supported: true });
    expect(states.get(4)).toMatchObject({ color: { r: 0.25, g: 0.25, b: 0.25 }, supported: true });
    expect(states.get(7)).toMatchObject({ color: { r: 0, g: 1, b: 1 }, supported: true });
  });

  it('marks invisible, stroke-only and pattern-filled text without guessing a colour', () => {
    const states = textPaintByOperator({
      fnArray: [
        OPS.setTextRenderingMode, OPS.showText,
        OPS.setTextRenderingMode, OPS.showText,
        OPS.setTextRenderingMode, OPS.setFillColorN, OPS.showText,
      ],
      argsArray: [[3], shown('A'), [1], shown('B'), [0], ['Pattern'], shown('C')],
    });

    expect(states.get(1)).toEqual({ renderingMode: 3, visible: false, supported: false });
    expect(states.get(3)).toEqual({
      strokeColor: { r: 0, g: 0, b: 0 },
      lineWidth: 1,
      renderingMode: 1,
      visible: true,
      supported: false,
    });
    expect(states.get(6)).toEqual({ renderingMode: 0, visible: true, supported: false });
  });

  it('resolves only same-colour thin mode-2 paint as synthetic bold', () => {
    const states = textPaintByOperator({
      fnArray: [
        OPS.setFillRGBColor, OPS.setStrokeRGBColor, OPS.setLineWidth,
        OPS.setTextRenderingMode, OPS.showText,
        OPS.setStrokeRGBColor, OPS.showText,
        OPS.setStrokeRGBColor, OPS.setLineWidth, OPS.showText,
        OPS.setStrokeColorN, OPS.setLineWidth, OPS.showText,
      ],
      argsArray: [
        [102, 99, 99], [102, 99, 99], [0.31], [2], shown('A'),
        [0, 0, 128], shown('B'),
        [102, 99, 99], [0.8], shown('C'),
        ['Pattern'], [0.31], shown('D'),
      ],
    });

    expect(resolveTextPaint(states.get(4)!, 10)).toMatchObject({
      color: { r: 102 / 255, g: 99 / 255, b: 99 / 255 },
      supported: true,
      syntheticBold: true,
    });
    expect(resolveTextPaint(states.get(6)!, 10).supported).toBe(false);
    expect(resolveTextPaint(states.get(9)!, 10).supported).toBe(false);
    expect(resolveTextPaint(states.get(12)!, 10).supported).toBe(false);
  });

  it('restores stroke colour and width with the graphics state', () => {
    const states = textPaintByOperator({
      fnArray: [
        OPS.setFillGray, OPS.setStrokeGray, OPS.setLineWidth, OPS.setTextRenderingMode,
        OPS.save, OPS.setStrokeCMYKColor, OPS.setLineWidth, OPS.showText,
        OPS.restore, OPS.showText,
      ],
      argsArray: [
        [0.25], [0.25], [0.3], [2],
        null, [0, 1, 1, 0], [1], shown('A'),
        null, shown('B'),
      ],
    });

    expect(states.get(7)).toMatchObject({
      strokeColor: { r: 1, g: 0, b: 0 },
      lineWidth: 1,
    });
    expect(states.get(9)).toMatchObject({
      strokeColor: { r: 0.25, g: 0.25, b: 0.25 },
      lineWidth: 0.3,
    });
  });
});

describe('textPaintForItems', () => {
  it('returns the paint state for each extracted item in text-show order', () => {
    const result = textPaintForItems(
      [{ str: 'White' }, { str: 'Black' }],
      {
        fnArray: [OPS.setFillGray, OPS.showText, OPS.setFillGray, OPS.showText],
        argsArray: [[1], shown('White'), [0], shown('Black')],
      },
    );

    expect(result?.[0]).toMatchObject({ color: { r: 1, g: 1, b: 1 } });
    expect(result?.[1]).toMatchObject({ color: { r: 0, g: 0, b: 0 } });
  });
});
