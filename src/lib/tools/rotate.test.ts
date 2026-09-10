// @vitest-environment jsdom
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_PAGE_RANGE_ERROR } from './pageRanges';
import { DEFAULT_ROTATE_OPTIONS } from './rotateOptions';
import { NO_TURN_ERROR, ROTATE_INPUT_ERROR, rotateTool, run } from './rotate';

function context(controller = new AbortController()) {
  return { signal: controller.signal, onProgress: vi.fn(), onWarning: vi.fn() };
}

async function fixture(pageTwoRotation = 90, name = 'sample.pdf') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 4; index++) {
    const page = doc.addPage([300 + index * 10, 400 + index * 10]);
    page.drawText(`Original content page ${index + 1}`, { x: 30, y: 350, font, size: 14 });
    if (index === 1 && pageTwoRotation) page.setRotation(degrees(pageTwoRotation));
  }
  return new File([(await doc.save()).slice().buffer], name, { type: 'application/pdf' });
}

async function open(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({ data: bytes.slice() }).promise;
}

async function rotations(bytes: Uint8Array): Promise<number[]> {
  const doc = await open(bytes);
  try {
    return await Promise.all(Array.from({ length: doc.numPages }, async (_, index) => (await doc.getPage(index + 1)).rotate));
  } finally { await doc.destroy(); }
}

async function pageText(doc: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber);
  return (await page.getTextContent()).items.map((item) => 'str' in item ? item.str : '').join(' ').trim();
}

describe('Rotate PDF', () => {
  it('rotates every page right and adds to an existing rotation', async () => {
    const ctx = context();
    const [output] = await run([await fixture()], { ...DEFAULT_ROTATE_OPTIONS, turns: 1 }, ctx);
    expect(await rotations(output!.bytes)).toEqual([90, 180, 90, 90]);
    expect(output).toMatchObject({ name: 'sample-rotated.pdf', mime: 'application/pdf' });
    expect(ctx.onProgress).toHaveBeenLastCalledWith(4, 4, 'Rotated PDF ready');
  });

  it('rotates only custom pages left', async () => {
    const [output] = await run([await fixture()], {
      ...DEFAULT_ROTATE_OPTIONS, turns: 3, pageSelection: 'custom', ranges: '2-3',
    }, context());
    expect(await rotations(output!.bytes)).toEqual([0, 0, 270, 0]);
  });

  it('rotates all initially upright pages by 180°', async () => {
    const [output] = await run([await fixture(0)], { ...DEFAULT_ROTATE_OPTIONS, turns: 2 }, context());
    expect(await rotations(output!.bytes)).toEqual([180, 180, 180, 180]);
  });

  it('preserves the original page content while changing rotation metadata', async () => {
    const input = await fixture();
    const original = await open(new Uint8Array(await input.arrayBuffer()));
    const [output] = await run([input], { ...DEFAULT_ROTATE_OPTIONS, turns: 1 }, context());
    const rotated = await open(output!.bytes);
    try {
      expect(rotated.numPages).toBe(original.numPages);
      for (let pageNumber = 1; pageNumber <= original.numPages; pageNumber++) {
        expect(await pageText(rotated, pageNumber)).toBe(await pageText(original, pageNumber));
      }
    } finally {
      await original.destroy();
      await rotated.destroy();
    }
  });

  it('rejects two files and empty custom ranges with friendly errors', async () => {
    const file = await fixture();
    await expect(run([file, file], { ...DEFAULT_ROTATE_OPTIONS, turns: 1 }, context())).rejects.toThrow(ROTATE_INPUT_ERROR);
    await expect(run([file], {
      ...DEFAULT_ROTATE_OPTIONS, turns: 1, pageSelection: 'custom', ranges: '',
    }, context())).rejects.toThrow(EMPTY_PAGE_RANGE_ERROR);
    expect(rotateTool).toMatchObject({ slug: 'rotate', accepts: 'pdf', multiple: false });
  });

  it('stops before reading the file when already aborted', async () => {
    const file = await fixture();
    const read = vi.spyOn(file, 'arrayBuffer');
    const controller = new AbortController();
    controller.abort();
    await expect(run([file], DEFAULT_ROTATE_OPTIONS, context(controller))).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects zero turns before reading the input and exposes the same canRun reason', async () => {
    const file = await fixture();
    const read = vi.spyOn(file, 'arrayBuffer');
    await expect(run([file], DEFAULT_ROTATE_OPTIONS, context())).rejects.toThrow(NO_TURN_ERROR);
    expect(read).not.toHaveBeenCalled();
    expect(rotateTool.canRun?.(DEFAULT_ROTATE_OPTIONS, [file])).toBe(NO_TURN_ERROR);
    expect(rotateTool.canRun?.({ ...DEFAULT_ROTATE_OPTIONS, turns: 1 }, [file])).toBeUndefined();
  });
});
