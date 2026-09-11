// @vitest-environment jsdom
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import { run } from './repair';
import { rescuePageList } from './repairRescue';
import type { ToolContext } from './types';

vi.mock('@/lib/pdf/worker', async () => ({ pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs') }));

function context(): ToolContext {
  return { signal: new AbortController().signal, onProgress: vi.fn(), onWarning: vi.fn() };
}

/** A small PDF written with plain (uncompressed) objects, as latin1 text we can cut up. */
async function plainPdf(labels: string[]): Promise<string> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const label of labels) document.addPage([300, 400]).drawText(label, { x: 40, y: 340, font, size: 18 });
  return Buffer.from(await document.save({ useObjectStreams: false })).toString('latin1');
}

/**
 * Remove the catalog and the page list, and everything from the index on — the state of a file whose download
 * stopped after the pages but before its page list (GOA 2026 keeps that list at 99.4% of the file).
 */
function withoutPageList(text: string): string {
  const cut = text
    .replace(/\d+ 0 obj\s*<<\s*\/Type \/Catalog[\s\S]*?endobj/, '')
    .replace(/\d+ 0 obj\s*<<\s*\/Type \/Pages\b[\s\S]*?endobj/, '');
  return cut.slice(0, cut.lastIndexOf('xref'));
}

function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  try {
    const texts: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      texts.push((await page.getTextContent()).items.map((item) => 'str' in item ? item.str : '').join(' ').trim());
    }
    return texts;
  } finally { await pdf.destroy(); }
}

describe('page rescue for files whose page list is gone', () => {
  it('rebuilds a page list for pages left without one, in reading order', async () => {
    const lost = bytesOf(withoutPageList(await plainPdf(['Alpha', 'Bravo', 'Charlie'])));
    await expect(getDocument({ data: lost.slice(), verbosity: 0 }).promise).rejects.toBeTruthy();

    const rescued = await rescuePageList(lost);
    expect(rescued).toMatchObject({ pageCount: 3, incompletePages: [] });
    expect(await pageTexts(rescued!.bytes)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('flags a page whose content is no longer in the file', async () => {
    const text = withoutPageList(await plainPdf(['Alpha', 'Bravo', 'Charlie']));
    // pdf-lib writes `/Contents [ 6 0 R ]` inside each page dictionary.
    const contentRefs = [...text.matchAll(/\/Type \/Page\b[\s\S]*?\/Contents \[?\s*(\d+) 0 R/g)].map((match) => match[1]);
    expect(contentRefs).toHaveLength(3);
    const missingThird = text.replace(new RegExp(`\\b${contentRefs[2]} 0 obj[\\s\\S]*?endobj`), '');

    const rescued = await rescuePageList(bytesOf(missingThird));
    expect(rescued).toMatchObject({ pageCount: 3, incompletePages: [2] });
  });

  it('drops a half-written object at a cut-off end instead of failing', async () => {
    const text = withoutPageList(await plainPdf(['Alpha', 'Bravo']));
    const cutMidObject = text.slice(0, text.lastIndexOf('endobj') - 12);
    const rescued = await rescuePageList(bytesOf(cutMidObject));
    expect(rescued?.pageCount).toBeGreaterThanOrEqual(1);
  });

  it('leaves files with a working page list to the other tries, and gives up on noise', async () => {
    expect(await rescuePageList(bytesOf(await plainPdf(['Alpha'])))).toBeUndefined();
    const noise = new Uint8Array(4096).map((_, index) => (index * 97 + 13) % 251);
    expect(await rescuePageList(noise)).toBeUndefined();
  });

  it('runs as part of Repair PDF and says what it found', async () => {
    const lost = bytesOf(withoutPageList(await plainPdf(['Alpha', 'Bravo', 'Charlie'])));
    const input = new File([lost.slice().buffer], 'stopped.pdf', { type: 'application/pdf', lastModified: 1 });
    const [output] = await run([input], {}, context());
    expect(output?.name).toBe('stopped-repaired.pdf');
    expect(output?.note).toEqual({
      text: "The file's page list was missing, so we searched the file and found 3 pages. All 3 were rebuilt. If the file was cut short, the pages after these are missing.",
      tone: 'warn',
    });
    expect(await pageTexts(output!.bytes)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });
});
