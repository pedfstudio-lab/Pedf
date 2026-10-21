import { describe, expect, it } from 'vitest';
import { cornerDragFactor, scaleTextBox } from './scaleTextBox';
import { wrapTextParagraphs } from './paragraphLayout';

const style = { fontName: 'Helvetica', fontSizePt: 20, bold: false, italic: false, color: { r: 0, g: 0, b: 0 } };
const box = { style, width: 240, spans: [
  { text: 'Normal ', bold: false, italic: false },
  { text: 'large', bold: true, italic: true, fontSizePt: 40 },
  { text: ' small', bold: false, italic: false, fontSizePt: 10 },
], paragraphs: [{ gapBeforePt: 6, firstIndentPt: 12, restIndentPt: 8, minimumWordGapEm: 0.1 }],
bullet: { indentPt: 20, itemSpacingPt: 5, markerSizePt: 18 } };

describe('revision 1 size-only corner scaling', () => {
  it('scales sizes only and preserves width, paragraph layout, bullet geometry and appearance', () => {
    const before = JSON.stringify(box), next = scaleTextBox(box, 2);
    expect(next.style).toEqual({ ...style, fontSizePt: 40 });
    expect(next.spans.map(span => span.fontSizePt)).toEqual([undefined, 80, 20]);
    expect(next.width).toBe(240);
    expect(next.paragraphs).toBe(box.paragraphs);
    expect(next.bullet).toBe(box.bullet);
    expect(next.spans[1]).toMatchObject({ bold: true, italic: true });
    expect(JSON.stringify(box)).toBe(before);
  });
  it('clamps the entire box at the smallest/largest text size', () => {
    expect(scaleTextBox(box, 0).factor).toBe(0.4);
    expect(scaleTextBox(box, 100).factor).toBe(10);
    expect(scaleTextBox(box, 0).spans[2]!.fontSizePt).toBe(4);
    expect(scaleTextBox(box, 100).spans[1]!.fontSizePt).toBe(400);
    for (const factor of [0, 100]) {
      const next = scaleTextBox(box, factor);
      expect(next.spans[1]!.fontSizePt! / next.spans[2]!.fontSizePt!).toBe(4);
      expect(next.width).toBe(box.width);
    }
  });
  it('weights both directions equally, independently of box shape, and adjusts for zoom', () => {
    expect(cornerDragFactor(100, 0, 20)).toBe(1.5);
    expect(cornerDragFactor(0, 100, 20)).toBe(1.5);
    expect(cornerDragFactor(-100, 0, 20)).toBe(0.5);
    expect(cornerDragFactor(0, -100, 20)).toBe(0.5);
    expect(cornerDragFactor(50, -50, 20)).toBe(1);
    expect(cornerDragFactor(200, 0, 20, 2)).toBe(1.5);
    expect(cornerDragFactor(0, 50, 20, 0.5)).toBe(1.5);
    expect(scaleTextBox(box, cornerDragFactor(0, 0, 20))).toEqual({ ...box, factor: 1 });
    expect(scaleTextBox(box, 1).spans).toBe(box.spans);
  });
  it.each([false, true])('rewraps at fixed width like the existing size-control path (mixed: %s)', mixed => {
    const text = 'Normal large small normal large small normal large small';
    const input = { ...box, text, spans: mixed ? [
      { text: 'Normal large ', bold: false, italic: false, fontSizePt: 30 },
      { text: text.slice(13), bold: true, italic: false },
    ] : undefined, height: 0, dx: 0, dy: 0 };
    const wraps = (value: typeof input) => wrapTextParagraphs(value,
      (word, span) => word.length * (span.fontSizePt ?? value.style.fontSizePt) / 2).map(line => line.text);
    const smaller = scaleTextBox(input, 0.5), larger = scaleTextBox(input, 1.5);
    expect(wraps(smaller).length).toBeLessThan(wraps(larger).length);
    for (const factor of [0.5, 1.5, 2]) {
      expect(wraps(scaleTextBox(input, factor))).toEqual(wraps({ ...input,
        style: { ...style, fontSizePt: style.fontSizePt * factor },
        spans: input.spans?.map(span => ({ ...span,
          ...(span.fontSizePt !== undefined ? { fontSizePt: span.fontSizePt * factor } : {}) })),
      }));
    }
  });
});
