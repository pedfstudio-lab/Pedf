import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  drawObject,
  PDFDict,
  PDFDocument,
  PDFName,
  popGraphicsState,
  pushGraphicsState,
  StandardFonts,
  translate,
} from 'pdf-lib';
import { itemIsCovered, planCoveredGlyphRemoval } from './coveredGlyphs';
import type { ContentStreamNode } from './coveredGlyphs';
import { tokenizeContentStream } from './contentStream';
import { buildPageStreamTree } from './formStreams';
import type { PdfRect } from './types';

function overlapCover(fraction: number): PdfRect {
  return { x: 0, y: 0, w: 100 * fraction, h: 20 };
}

async function streamNodes(bytes: Uint8Array, pageIndex = 0): Promise<readonly ContentStreamNode[]> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  return buildPageStreamTree(document, pageIndex)?.roots ?? [];
}

function extraNode(key: string, source: string): ContentStreamNode {
  return { key, tokens: tokenizeContentStream(new TextEncoder().encode(source)), form: () => null };
}

async function generatedPage(): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([400, 500]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('REMOVE ME', { x: 50, y: 420, size: 20, font });
  page.drawText('KEEP ME', { x: 50, y: 350, size: 20, font });
  return document.save();
}

/** A page whose text is painted through a Form XObject, as Canva exports do. */
async function formPage(copies = 1): Promise<Uint8Array> {
  const source = await PDFDocument.create({ updateMetadata: false });
  const sourcePage = source.addPage([200, 200]);
  const font = await source.embedFont(StandardFonts.Helvetica);
  sourcePage.drawText('FORM TEXT', { x: 20, y: 100, size: 16, font });
  const target = await PDFDocument.create({ updateMetadata: false });
  const [embedded] = await target.embedPdf(await source.save(), [0]);
  const page = target.addPage([200, 200]);
  page.drawPage(embedded!);
  // A second stamp of the *same* resource name: one stream, two placements.
  for (let index = 1; index < copies; index += 1) {
    const [name] = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict).keys() ?? [];
    if (!name) throw new Error('the embedded form has no resource name');
    page.pushOperators(
      pushGraphicsState(),
      translate(0, index * 5),
      drawObject(name.asString().slice(1)),
      popGraphicsState(),
    );
  }
  return target.save();
}

async function planFor(
  bytes: Uint8Array,
  covers: readonly PdfRect[],
  nodes?: readonly ContentStreamNode[],
) {
  const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  try {
    const page = await pdf.getPage(1);
    return planCoveredGlyphRemoval(
      (await page.getTextContent()).items,
      await page.getOperatorList(),
      page.getViewport({ scale: 1, rotation: 0 }),
      nodes ?? (await streamNodes(bytes)),
      covers,
    );
  } finally {
    await pdf.destroy();
  }
}

describe('covered item threshold', () => {
  const item = { x: 0, y: 0, w: 100, h: 20 };
  it('removes items at 100% and 91% coverage', () => {
    expect(itemIsCovered(item, [overlapCover(1)])).toBe(true);
    expect(itemIsCovered(item, [overlapCover(0.91)])).toBe(true);
  });
  it('keeps items at 50% and 89% coverage', () => {
    expect(itemIsCovered(item, [overlapCover(0.5)])).toBe(false);
    expect(itemIsCovered(item, [overlapCover(0.89)])).toBe(false);
  });
});

describe('covered glyph planning', () => {
  it('plans only the fully covered generated text item', async () => {
    const plan = await planFor(await generatedPage(), [{ x: 45, y: 415, w: 130, h: 30 }]);

    expect(plan.skipped).toBe(false);
    expect(plan.removedItems).toBe(1);
    expect(plan.rewrites).toHaveLength(1);
    expect(plan.rewrites[0]?.streamKey).toBe('page:0');
    expect(plan.rewrites[0]?.removedRanges).toEqual([
      { start: 0, end: 6 },
      { start: 7, end: 9 },
    ]);
  });

  it('fails closed when tokenizer and PDF.js operator counts differ', async () => {
    const bytes = await generatedPage();
    const nodes = [...(await streamNodes(bytes)), extraNode('page:extra', '(extra) Tj')];
    const plan = await planFor(bytes, [{ x: 0, y: 0, w: 400, h: 500 }], nodes);

    expect(plan.skipped).toBe(true);
    expect(plan.reason).toMatch(/counts differ/);
  });

  it('plans text painted through a Form XObject', async () => {
    const plan = await planFor(await formPage(), [{ x: 0, y: 0, w: 200, h: 200 }]);

    expect(plan.skipped).toBe(false);
    expect(plan.removedItems).toBe(1);
    expect(plan.rewrites[0]?.streamKey).toMatch(/^page\//);
  });

  it('fails closed when the same form is painted twice on one page', async () => {
    const plan = await planFor(await formPage(2), [{ x: 0, y: 0, w: 200, h: 200 }]);

    expect(plan.skipped).toBe(true);
    expect(plan.reason).toMatch(/painted more than once/);
  });
});
