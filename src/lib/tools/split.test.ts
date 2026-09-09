import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SPLIT_OPTIONS } from './splitOptions';
import { buildSplitGroups, EVERY_N_ERROR, run, SPLIT_INPUT_ERROR, splitTool } from './split';
import { EMPTY_PAGE_RANGE_ERROR, PAGE_RANGE_FORMAT_ERROR, REVERSED_PAGE_RANGE_ERROR } from './pageRanges';
import { PDF_ERRORS } from './pdfIo';

const goa = () => new File([readFileSync('public/samples/GOA 2026.pdf')], 'GOA 2026.pdf', { type: 'application/pdf' });
const context = (controller = new AbortController()) => ({ signal: controller.signal, onProgress: vi.fn() });
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
async function pageText(doc: PDFDocumentProxy, pageNumber: number) {
  const page = await doc.getPage(pageNumber);
  return normalize((await page.getTextContent()).items.map((item) => 'str' in item ? item.str : '').join(' '));
}

describe('split group options', () => {
  it('builds custom groups separately or combines them in entered order', () => {
    expect(buildSplitGroups({ ...DEFAULT_SPLIT_OPTIONS, ranges: '1-3, 5' }, 16)).toEqual([[0, 1, 2], [4]]);
    expect(buildSplitGroups({ ...DEFAULT_SPLIT_OPTIONS, ranges: '1-3, 5', mergeRanges: true }, 16)).toEqual([[0, 1, 2, 4]]);
  });

  it('builds one group for every page', () => {
    expect(buildSplitGroups({ ...DEFAULT_SPLIT_OPTIONS, mode: 'every-page' }, 4)).toEqual([[0], [1], [2], [3]]);
  });

  it('builds every-N groups with a shorter final group', () => {
    expect(buildSplitGroups({ ...DEFAULT_SPLIT_OPTIONS, mode: 'every-n', everyN: 3 }, 8)).toEqual([[0, 1, 2], [3, 4, 5], [6, 7]]);
  });

  it.each([0, -2, 1.5, Number.NaN])('rejects an invalid every-N value: %s', (everyN) => {
    expect(() => buildSplitGroups({ mode: 'every-n', everyN }, 8)).toThrow(EVERY_N_ERROR);
  });
});

describe('Split PDF', () => {
  it('registers as a single-PDF tool with custom ranges by default', () => {
    expect(splitTool.slug).toBe('split');
    expect(splitTool.accepts).toBe('pdf');
    expect(splitTool.multiple).toBe(false);
    expect(splitTool.defaultOptions).toEqual(DEFAULT_SPLIT_OPTIONS);
  });

  it('splits GOA into two custom outputs with the right counts, names, text, sizes and rotation', async () => {
    const file = goa();
    const originalBytes = new Uint8Array(await file.arrayBuffer());
    const source = await getDocument({ data: originalBytes.slice() }).promise;
    const ctx = context();
    try {
      const outputs = await run([file], { ...DEFAULT_SPLIT_OPTIONS, ranges: '1-3, 5' }, ctx);
      expect(outputs.map(({ name }) => name)).toEqual(['GOA 2026-pages-1-3.pdf', 'GOA 2026-page-5.pdf']);
      const first = await getDocument({ data: outputs[0]!.bytes.slice() }).promise;
      const second = await getDocument({ data: outputs[1]!.bytes.slice() }).promise;
      try {
        expect(first.numPages).toBe(3);
        expect(second.numPages).toBe(1);
        expect(await pageText(first, 1)).toBe(await pageText(source, 1));
        expect(await pageText(first, 3)).toBe(await pageText(source, 3));
        expect(await pageText(second, 1)).toBe(await pageText(source, 5));
        for (const [result, sourceNumber] of [[await first.getPage(1), 1], [await first.getPage(3), 3], [await second.getPage(1), 5]] as const) {
          const original = await source.getPage(sourceNumber);
          expect(result.view).toEqual(original.view);
          expect(result.rotate).toBe(original.rotate);
        }
      } finally { await first.destroy(); await second.destroy(); }
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(originalBytes);
      expect(ctx.onProgress).toHaveBeenLastCalledWith(2, 2, 'Split PDFs ready');
    } finally { await source.destroy(); }
  });

  it('creates 16 one-page PDFs in order for every-page mode', async () => {
    const outputs = await run([goa()], { ...DEFAULT_SPLIT_OPTIONS, mode: 'every-page' }, context());
    expect(outputs).toHaveLength(16);
    expect(outputs[0]?.name).toBe('GOA 2026-page-1.pdf');
    expect(outputs[15]?.name).toBe('GOA 2026-page-16.pdf');
    for (const output of outputs) {
      const doc = await getDocument({ data: output.bytes.slice() }).promise;
      try { expect(doc.numPages).toBe(1); } finally { await doc.destroy(); }
    }
  });

  it('creates every-N groups and labels the shorter final range', async () => {
    const outputs = await run([goa()], { ...DEFAULT_SPLIT_OPTIONS, mode: 'every-n', everyN: 7 }, context());
    expect(outputs.map(({ name }) => name)).toEqual([
      'GOA 2026-pages-1-7.pdf', 'GOA 2026-pages-8-14.pdf', 'GOA 2026-pages-15-16.pdf',
    ]);
    const pages = await Promise.all(outputs.map(async (output) => (await PDFDocument.load(output.bytes)).getPageCount()));
    expect(pages).toEqual([7, 7, 2]);
  });

  it('merges selected ranges into one PDF while preserving the requested discontinuous order', async () => {
    const outputs = await run([goa()], { ...DEFAULT_SPLIT_OPTIONS, ranges: '5, 1-2', mergeRanges: true }, context());
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.name).toBe('GOA 2026-pages-5_1-2.pdf');
    const source = await getDocument({ data: new Uint8Array(await goa().arrayBuffer()) }).promise;
    const output = await getDocument({ data: outputs[0]!.bytes.slice() }).promise;
    try {
      expect(output.numPages).toBe(3);
      expect(await pageText(output, 1)).toBe(await pageText(source, 5));
      expect(await pageText(output, 2)).toBe(await pageText(source, 1));
    } finally { await source.destroy(); await output.destroy(); }
  });

  it.each([
    ['', EMPTY_PAGE_RANGE_ERROR],
    ['1-3,', PAGE_RANGE_FORMAT_ERROR],
    ['9-2', REVERSED_PAGE_RANGE_ERROR],
    ['17', 'Page numbers must be between 1 and 16.'],
  ])('rejects bad custom range %j before producing output', async (ranges, message) => {
    await expect(run([goa()], { ...DEFAULT_SPLIT_OPTIONS, ranges }, context())).rejects.toThrow(message);
  });

  it('rejects missing, multiple, non-PDF, corrupt and encrypted input with friendly messages', async () => {
    await expect(run([], DEFAULT_SPLIT_OPTIONS, context())).rejects.toThrow(SPLIT_INPUT_ERROR);
    await expect(run([goa(), goa()], DEFAULT_SPLIT_OPTIONS, context())).rejects.toThrow(SPLIT_INPUT_ERROR);
    await expect(run([new File(['text'], 'notes.txt')], DEFAULT_SPLIT_OPTIONS, context())).rejects.toThrow(PDF_ERRORS.type);
    await expect(run([new File(['broken'], 'broken.pdf')], DEFAULT_SPLIT_OPTIONS, context())).rejects.toThrow(PDF_ERRORS.corrupt);
    const encrypted = await PDFDocument.create(); encrypted.addPage();
    encrypted.context.trailerInfo.Encrypt = encrypted.context.register(encrypted.context.obj({ Filter: 'Standard' }));
    const file = new File([(await encrypted.save()).slice().buffer], 'locked.pdf', { type: 'application/pdf' });
    await expect(run([file], DEFAULT_SPLIT_OPTIONS, context())).rejects.toThrow(PDF_ERRORS.encrypted);
  });

  it('honours cancellation before parsing and between output groups', async () => {
    const before = new AbortController(); before.abort();
    await expect(run([goa()], { ...DEFAULT_SPLIT_OPTIONS, mode: 'every-page' }, context(before))).rejects.toMatchObject({ name: 'AbortError' });
    const during = new AbortController();
    const ctx = context(during);
    ctx.onProgress.mockImplementation((done: number) => { if (done === 1) during.abort(); });
    await expect(run([goa()], { ...DEFAULT_SPLIT_OPTIONS, mode: 'every-page' }, ctx)).rejects.toMatchObject({ name: 'AbortError' });
    expect(ctx.onProgress.mock.calls.some((call) => call[2] === 'Split PDFs ready')).toBe(false);
  });
});
