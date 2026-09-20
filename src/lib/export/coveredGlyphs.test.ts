import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  decodePDFRawStream,
  PDFArray,
  PDFContentStream,
  PDFDocument,
  PDFRawStream,
  PDFStream,
  StandardFonts,
} from 'pdf-lib';
import { itemIsCovered, planCoveredGlyphRemoval } from './coveredGlyphs';
import { tokenizeContentStream } from './contentStream';
import type { PdfRect } from './types';

function overlapCover(fraction: number): PdfRect {
  return { x: 0, y: 0, w: 100 * fraction, h: 20 };
}

function decoded(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFContentStream) return stream.getUnencodedContents();
  if (stream instanceof PDFRawStream && stream.dict.get(stream.dict.context.obj('Filter'))) {
    return decodePDFRawStream(stream).decode();
  }
  return stream.getContents();
}

async function contentStreams(bytes: Uint8Array, pageIndex = 0): Promise<Uint8Array[]> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const contents = document.getPage(pageIndex).node.Contents();
  if (!contents) return [];
  if (contents instanceof PDFStream) return [decoded(contents)];
  if (!(contents instanceof PDFArray)) return [];
  const streams: Uint8Array[] = [];
  for (let index = 0; index < contents.size(); index += 1) {
    const stream = contents.lookupMaybe(index, PDFStream);
    if (stream) streams.push(decoded(stream));
  }
  return streams;
}

async function generatedPage(): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([400, 500]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('REMOVE ME', { x: 50, y: 420, size: 20, font });
  page.drawText('KEEP ME', { x: 50, y: 350, size: 20, font });
  return document.save();
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
    const bytes = await generatedPage();
    const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    try {
      const page = await pdf.getPage(1);
      const content = await page.getTextContent();
      const operators = await page.getOperatorList();
      const streams = (await contentStreams(bytes)).map(tokenizeContentStream);
      const plan = planCoveredGlyphRemoval(
        content.items,
        operators,
        page.getViewport({ scale: 1, rotation: 0 }),
        streams,
        [{ x: 45, y: 415, w: 130, h: 30 }],
      );

      expect(plan.skipped).toBe(false);
      expect(plan.removedItems).toBe(1);
      expect(plan.rewrites).toHaveLength(1);
      expect(plan.rewrites[0]?.removedRanges).toEqual([
        { start: 0, end: 6 },
        { start: 7, end: 9 },
      ]);
    } finally {
      await pdf.destroy();
    }
  });

  it('fails closed when tokenizer and PDF.js operator counts differ', async () => {
    const bytes = await generatedPage();
    const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    try {
      const page = await pdf.getPage(1);
      const content = await page.getTextContent();
      const operators = await page.getOperatorList();
      const streams = await contentStreams(bytes);
      streams.push(new TextEncoder().encode('(extra) Tj'));
      const plan = planCoveredGlyphRemoval(
        content.items,
        operators,
        page.getViewport({ scale: 1, rotation: 0 }),
        streams.map(tokenizeContentStream),
        [{ x: 0, y: 0, w: 400, h: 500 }],
      );
      expect(plan.skipped).toBe(true);
      expect(plan.reason).toMatch(/counts differ/);
    } finally {
      await pdf.destroy();
    }
  });

  it('fails closed when text is painted through a Form XObject', async () => {
    const source = await PDFDocument.create({ updateMetadata: false });
    const sourcePage = source.addPage([200, 200]);
    const font = await source.embedFont(StandardFonts.Helvetica);
    sourcePage.drawText('FORM TEXT', { x: 20, y: 100, size: 16, font });
    const target = await PDFDocument.create({ updateMetadata: false });
    const [embedded] = await target.embedPdf(await source.save(), [0]);
    const page = target.addPage([200, 200]);
    page.drawPage(embedded!);
    const bytes = await target.save();
    const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    try {
      const proxy = await pdf.getPage(1);
      const plan = planCoveredGlyphRemoval(
        (await proxy.getTextContent()).items,
        await proxy.getOperatorList(),
        proxy.getViewport({ scale: 1, rotation: 0 }),
        (await contentStreams(bytes)).map(tokenizeContentStream),
        [{ x: 0, y: 0, w: 200, h: 200 }],
      );
      expect(plan.skipped).toBe(true);
      expect(plan.reason).toMatch(/Form XObject/);
    } finally {
      await pdf.destroy();
    }
  });
});
