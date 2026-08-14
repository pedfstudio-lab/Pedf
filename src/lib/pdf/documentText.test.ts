import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  buildDocumentText,
  DOCUMENT_TRUNCATED_MARKER,
  extractDocumentText,
  getDocumentText,
} from './documentText';

const openDocuments: PDFDocumentProxy[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(openDocuments.splice(0).map((document) => document.destroy()));
});

async function makeDocument(pageTexts: readonly string[]): Promise<PDFDocumentProxy> {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = source.addPage([612, 792]);
    page.drawText(text, { x: 72, y: 700, size: 16, font });
  }

  const document = await getDocument({
    data: (await source.save()).slice(),
    verbosity: 0,
  }).promise;
  openDocuments.push(document);
  return document;
}

describe('extractDocumentText', () => {
  it('extracts recognizable text from every page of the bundled itinerary', async () => {
    const bytes = new Uint8Array(await readFile(
      new URL('../../../public/samples/sample-basic.pdf', import.meta.url),
    ));
    const document = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
    openDocuments.push(document);

    const result = await extractDocumentText(document);

    expect(result.pages).toHaveLength(document.numPages);
    expect(result.pages[0]).toContain('Travel Itinerary');
    expect(result.full).toContain('[Page 1]');
    expect(result.full).toContain(`[Page ${document.numPages}]`);
  });

  it('aggregates clean page text in order with one-based page markers', async () => {
    const document = await makeDocument([
      'Destination: Goa',
      'Check-in at 3 PM',
    ]);

    const result = await extractDocumentText(document);

    expect(result.pages).toHaveLength(document.numPages);
    expect(result.pages[0]).toContain('Destination: Goa');
    expect(result.pages[1]).toContain('Check-in at 3 PM');
    expect(result.full).toContain('[Page 1]\nDestination: Goa');
    expect(result.full).toContain('[Page 2]\nCheck-in at 3 PM');
    expect(result.full.indexOf('[Page 1]')).toBeLessThan(result.full.indexOf('[Page 2]'));
    expect(result.charCount).toBeGreaterThan(0);
  });

  it('shares one extraction across concurrent callers for the same document', async () => {
    const document = await makeDocument(['Page one', 'Page two']);
    const getPage = vi.spyOn(document, 'getPage');

    const first = getDocumentText(document);
    const second = getDocumentText(document);

    expect(second).toBe(first);
    expect(await second).toBe(await first);
    expect(getPage).toHaveBeenCalledTimes(document.numPages);
  });
});

describe('buildDocumentText', () => {
  it('caps oversized context and records the complete pre-truncation size', () => {
    const maxChars = 80;
    const result = buildDocumentText(['A'.repeat(200)], maxChars);

    expect(result.pages[0]).toHaveLength(200);
    expect(result.full).toHaveLength(maxChars);
    expect(result.full.endsWith(DOCUMENT_TRUNCATED_MARKER)).toBe(true);
    expect(result.charCount).toBeGreaterThan(result.full.length);
  });
});
