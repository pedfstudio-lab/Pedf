import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { extractDocumentText } from './documentText';
import { extractTextRuns, groupRunsIntoBlocks } from './textContent';

const directory = 'tmp/text-doubling';
const available = ['ziro.pdf', 'rishi-edited.pdf', 'corporate-edited-3.pdf', 'rahul-rajput-edited.pdf']
  .every((file) => existsSync(`${directory}/${file}`));
if (!available) process.stdout.write(`Task 66 real-file checks skipped: ${directory}/ is missing samples.\n`);
const documents: PDFDocumentProxy[] = [];

async function open(file: string): Promise<PDFDocumentProxy> {
  const data = new Uint8Array(await readFile(file));
  const document = await getDocument({ data, verbosity: 0 }).promise;
  documents.push(document);
  return document;
}

afterEach(async () => {
  await Promise.all(documents.splice(0).map((document) => document.destroy()));
});

describe.skipIf(!available)('Task 66 real doubled-text samples', () => {
  it('reads the Ziro page-one title and whole document without doubled letters', async () => {
    const document = await open(`${directory}/ziro.pdf`);
    const blocks = groupRunsIntoBlocks(await extractTextRuns(await document.getPage(1), 0));
    const title = blocks.map((block) => block.text).join('\n');
    const documentText = await extractDocumentText(document);

    expect(title).toContain('ZIRO FESTIVAL');
    expect(title).not.toContain('ZZIIRROO');
    expect(documentText.full).toContain('ZIRO FESTIVAL');
    expect(documentText.full).not.toContain('ZZIIRROO');
  });

  it('reads only the newest name in the reopened Rishi edit', async () => {
    const document = await open(`${directory}/rishi-edited.pdf`);
    const runs = await extractTextRuns(await document.getPage(1), 0);
    const blocks = groupRunsIntoBlocks(runs);

    expect(blocks.some((block) => block.text === 'Utkarsh Taneja')).toBe(true);
    expect(runs.some((run) => run.text.includes('Rishi Khandelwal'))).toBe(false);
  });

  it('reads the newest university line on Corporate Governance page four', async () => {
    const document = await open(`${directory}/corporate-edited-3.pdf`);
    const blocks = groupRunsIntoBlocks(await extractTextRuns(await document.getPage(4), 3));
    const text = blocks.map((block) => block.text).join('\n');

    expect(text).toContain("Universities and I'm going for the bath");
    expect(text).not.toContain('Universities. Universities');
  }, 20_000);

  it('does not glue covered résumé bullet text to its edited replacement', async () => {
    const document = await open(`${directory}/rahul-rajput-edited.pdf`);
    const text = (await extractDocumentText(document)).full;

    expect(text).not.toContain('J Joined');
    expect(text).not.toContain('• J Joined');
  });
});

describe.skipIf(!existsSync('tmp/bullets/RAHUL_RAJPUT_RESUME.pdf'))(
  'Task 66 untouched résumé', () => {
    it('keeps every normal text item as an extractable run', async () => {
      const document = await open('tmp/bullets/RAHUL_RAJPUT_RESUME.pdf');
      const page = await document.getPage(1);
      const content = await page.getTextContent();
      const runs = await extractTextRuns(page, 0);
      const printable = content.items.filter((item) => (
        'str' in item && item.str.trim() !== '' && item.width !== 0
      ));

      expect(runs).toHaveLength(printable.length);
      expect(runs.map((run) => run.text)).toEqual(printable.map((item) => (
        'str' in item ? item.str : ''
      )));
    });
  },
);
