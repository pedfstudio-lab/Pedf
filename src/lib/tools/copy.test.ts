import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { copyTool } from './copy';

describe('hidden Copy PDF smoke test', () => {
  it('copies a bundled sample and reopens each output locally', async () => {
    const file = new File([readFileSync('public/samples/sample-basic.pdf')], 'sample-basic.pdf', { type: 'application/pdf' });
    const original = await getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const onProgress = vi.fn();
    try {
      const outputs = await copyTool.run([file, file], {}, { onProgress, signal: new AbortController().signal });
      expect(outputs).toHaveLength(2);
      for (const output of outputs) {
        expect(output.name).toBe('sample-basic-copy.pdf');
        const reopened = await getDocument({ data: output.bytes.slice() }).promise;
        try {
          expect(reopened.numPages).toBe(original.numPages);
          const expectedPage = await original.getPage(1);
          const actualPage = await reopened.getPage(1);
          expect(actualPage.getViewport({ scale: 1 }).viewBox).toEqual(expectedPage.getViewport({ scale: 1 }).viewBox);
          const text = (await actualPage.getTextContent()).items.map((item) => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ');
          expect(text).toContain('Travel Itinerary');
        } finally { await reopened.destroy(); }
      }
      expect(onProgress).toHaveBeenLastCalledWith(2, 2, 'Copied sample-basic.pdf');
    } finally { await original.destroy(); }
  });

  it('honours an already-aborted signal without reading the input', async () => {
    const controller = new AbortController(); controller.abort();
    const file = new File(['bad'], 'never-read.pdf');
    await expect(copyTool.run([file], {}, { onProgress: vi.fn(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
