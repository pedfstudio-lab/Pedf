import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  detectRuleLines,
  ruleLinesFromOperatorList,
} from './ruleLines';

describe('ruleLinesFromOperatorList', () => {
  it('detects horizontal and vertical segments but rejects a stroked rectangle', () => {
    const lines = ruleLinesFromOperatorList({
      fnArray: [
        OPS.setLineWidth,
        OPS.constructPath,
        OPS.stroke,
        OPS.constructPath,
        OPS.stroke,
        OPS.constructPath,
        OPS.stroke,
      ],
      argsArray: [
        [1.25],
        [[OPS.moveTo, OPS.lineTo], [20, 100, 280, 100]],
        null,
        [[OPS.moveTo, OPS.lineTo], [150, 20, 150, 220]],
        null,
        [[OPS.rectangle], [30, 30, 100, 60]],
        null,
      ],
    }, 0, { x: 0, y: 0, width: 300, height: 240 });

    expect(lines).toHaveLength(2);
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orientation: 'horizontal',
        x1: 20,
        y1: 100,
        x2: 280,
        thicknessPt: 1.25,
      }),
      expect.objectContaining({
        orientation: 'vertical',
        x1: 150,
        y1: 20,
        y2: 220,
        thicknessPt: 1.25,
      }),
    ]));
  });

  it('detects a thin filled rectangle and merges collinear pieces before length filtering', () => {
    const lines = ruleLinesFromOperatorList({
      fnArray: [
        OPS.setFillRGBColor,
        OPS.constructPath,
        OPS.fill,
        OPS.constructPath,
        OPS.fill,
      ],
      argsArray: [
        new Uint8ClampedArray([30, 60, 90]),
        [[OPS.rectangle], [20, 80, 55, 2]],
        null,
        [[OPS.rectangle], [75, 80, 65, 2]],
        null,
      ],
    }, 0, { x: 0, y: 0, width: 200, height: 160 });

    expect(lines).toEqual([
      expect.objectContaining({
        orientation: 'horizontal',
        x1: 20,
        y1: 81,
        x2: 140,
        thicknessPt: 2,
        color: {
          r: 30 / 255,
          g: 60 / 255,
          b: 90 / 255,
        },
      }),
    ]);
  });

  it('rejects an exact-width text underline and a page-frame edge', () => {
    const lines = ruleLinesFromOperatorList({
      fnArray: [
        OPS.constructPath,
        OPS.stroke,
        OPS.constructPath,
        OPS.stroke,
      ],
      argsArray: [
        [[OPS.moveTo, OPS.lineTo], [40, 97, 180, 97]],
        null,
        [[OPS.moveTo, OPS.lineTo], [0, 0, 300, 0]],
        null,
      ],
    }, 0, { x: 0, y: 0, width: 300, height: 200 }, [
      { x: 40, baselineY: 100, width: 140, height: 12 },
    ]);

    expect(lines).toEqual([]);
  });
});

describe('detectRuleLines fixtures', () => {
  it('finds the five full-width section dividers in the RAHUL resume', async () => {
    const bytes = await readFile('public/samples/RAHUL RAJPUT RESUME.pdf');
    const document = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
    try {
      const pages = await Promise.all([1, 2].map(async (pageNumber) => {
        const page = await document.getPage(pageNumber);
        return detectRuleLines(page, pageNumber - 1);
      }));
      const lines = pages.flat();

      expect(lines).toHaveLength(5);
      expect(lines.every((line) => line.orientation === 'horizontal')).toBe(true);
      expect(lines.every((line) => line.x2 - line.x1 > 450)).toBe(true);
      expect(lines.map((line) => Number(line.thicknessPt.toFixed(2)))).toEqual([
        0.75, 0.75, 0.75, 0.75, 0.75,
      ]);
    } finally {
      await document.destroy();
    }
  });

  it('does not mistake GOA timeline ticks or text underlines for divider rules', async () => {
    const bytes = await readFile('public/samples/GOA 2026.pdf');
    const document = await getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
    try {
      const pages = await Promise.all([3, 14, 16].map(async (pageNumber) => {
        const page = await document.getPage(pageNumber);
        return detectRuleLines(page, pageNumber - 1);
      }));
      expect(pages.flat()).toEqual([]);
    } finally {
      await document.destroy();
    }
  });
});
