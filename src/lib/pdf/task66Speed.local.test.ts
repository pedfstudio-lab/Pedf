import { readFile } from 'node:fs/promises';
import { describe, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractDocumentText } from './documentText';

describe('Task 66 local speed check', () => {
  it('measures complete GOA 2026 text extraction', async () => {
    const bytes = new Uint8Array(await readFile('public/samples/GOA 2026.pdf'));
    const document = await getDocument({ data: bytes, verbosity: 0 }).promise;
    try {
      const before = performance.now();
      const text = await extractDocumentText(document);
      const milliseconds = performance.now() - before;
      process.stdout.write(`GOA documentText: ${milliseconds.toFixed(1)} ms, ${text.charCount} chars, ${document.numPages} pages\n`);
    } finally {
      await document.destroy();
    }
  }, 30_000);
});
