import { afterEach, describe, expect, it } from 'vitest';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  BlendMode,
  clip,
  endPath,
  PDFDocument,
  rectangle,
  rgb,
  StandardFonts,
} from 'pdf-lib';
import { extractTextRuns, groupRunsIntoBlocks } from './textContent';
import { isRunCoveredByBox, mapTextItemsToOperators } from './hiddenText';

const documents: PDFDocumentProxy[] = [];

afterEach(async () => {
  await Promise.all(documents.splice(0).map((document) => document.destroy()));
});

async function textWithBox(
  placement: 'before' | 'after' | 'half' | 'opacity' | 'multiply' | 'clip',
): Promise<string[]> {
  const source = await PDFDocument.create();
  const page = source.addPage([612, 792]);
  const font = await source.embedFont(StandardFonts.Helvetica);
  const old = 'OLD WORDS';
  const newer = 'NEW WORDS';
  const size = 20;
  const oldWidth = font.widthOfTextAtSize(old, size);
  const box = {
    x: 70, y: 698, width: oldWidth + 5, height: 24,
    color: rgb(1, 1, 1),
  };
  if (placement === 'before') page.drawRectangle({ ...box, color: rgb(0.8, 0.9, 1) });
  page.drawText(old, { x: 72, y: 700, size, font });
  if (placement === 'after') page.drawRectangle(box);
  if (placement === 'half') page.drawRectangle({ ...box, width: oldWidth / 2 });
  if (placement === 'opacity') page.drawRectangle({ ...box, opacity: 0.5 });
  if (placement === 'multiply') page.drawRectangle({ ...box, blendMode: BlendMode.Multiply });
  if (placement === 'clip') {
    page.pushOperators(rectangle(box.x, box.y, box.width, box.height), clip(), endPath());
  }
  if (placement === 'after') page.drawText(newer, { x: 72, y: 700, size, font });

  const document = await getDocument({ data: (await source.save()).slice(), verbosity: 0 }).promise;
  documents.push(document);
  const blocks = groupRunsIntoBlocks(await extractTextRuns(await document.getPage(1), 0));
  return blocks.map((block) => block.text);
}

describe('paint-order text mapping', () => {
  const glyph = (unicode: string) => ({ unicode });
  it('consumes characters across text-showing operators while ignoring whitespace', () => {
    const mapped = mapTextItemsToOperators(
      [{ str: 'OLD WORDS' }, { str: 'NEW' }, { str: ' WORDS' }],
      {
        fnArray: [OPS.showText, OPS.fill, OPS.showText, OPS.showSpacedText],
        argsArray: [
          [[glyph('OLD'), glyph(' '), glyph('WORDS')]],
          null,
          [[glyph('NEW')]],
          [[glyph(' '), glyph('WORDS')]],
        ],
      },
    );
    expect(mapped).toEqual([0, 2, 3]);
  });

  it('returns no mapping when a character does not line up', () => {
    expect(mapTextItemsToOperators(
      [{ str: 'VISIBLE' }],
      { fnArray: [OPS.showText], argsArray: [[[glyph('DIFFERENT')]]] },
    )).toBeNull();
  });

  it('allows a trailing annotation appearance omitted from text content', () => {
    expect(mapTextItemsToOperators(
      [{ str: 'Form 1' }],
      {
        fnArray: [OPS.showText, OPS.showText],
        argsArray: [[[glyph('Form 1')]], [[glyph('Alice')]]],
      },
    )).toEqual([0]);
  });
});

describe('opaque later rectangles', () => {
  it('drops old text beneath a later white cover and retains the redraw', async () => {
    expect(await textWithBox('after')).toEqual(['NEW WORDS']);
  });

  it.each(['before', 'half', 'opacity', 'multiply', 'clip'] as const)(
    'keeps visible or uncertain text for a %s box', async (placement) => {
      expect(await textWithBox(placement)).toEqual(['OLD WORDS']);
    },
  );
});

describe('ink-hugging cover geometry', () => {
  const run = { x: 10, y: 20, w: 100, h: 20 };

  it.each([0.72, 0.76])(
    'hides a full-width cover spanning %s of the run height and its middle line',
    (heightShare) => {
      const height = run.h * heightShare;
      expect(isRunCoveredByBox(run, {
        x: run.x,
        y: run.y + (run.h - height) / 2,
        w: run.w,
        h: height,
      })).toBe(true);
    },
  );

  it('keeps a full-width cover spanning only 55% of the run height', () => {
    const height = run.h * 0.55;
    expect(isRunCoveredByBox(run, {
      x: run.x,
      y: run.y + (run.h - height) / 2,
      w: run.w,
      h: height,
    })).toBe(false);
  });

  it('keeps a tall cover that sits above the run middle line', () => {
    expect(isRunCoveredByBox(run, {
      x: run.x,
      y: run.y + run.h * 0.55,
      w: run.w,
      h: run.h * 0.8,
    })).toBe(false);
  });

  it('keeps a cover spanning only 90% of the run width', () => {
    expect(isRunCoveredByBox(run, {
      x: run.x,
      y: run.y,
      w: run.w * 0.9,
      h: run.h,
    })).toBe(false);
  });
});
