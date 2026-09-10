// @vitest-environment jsdom
import { PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_PLAN_ERROR,
  FORMS_WARNING,
  MISSING_FILE_ERROR,
  NO_CHANGE_ERROR,
  canRun,
  organizeTool,
  run,
} from './organize';
import { createEntries, fileKey, insertBlankAfter, movePage, rememberPageCount, type OrganizePlan } from './organizePlan';

function context(controller = new AbortController()) {
  return { signal: controller.signal, onProgress: vi.fn(), onWarning: vi.fn() };
}

function ids(prefix = 'page') {
  let index = 0;
  return () => `${prefix}-${index++}`;
}

async function fixture(name: string, prefix: string, count = 4, withForm = false) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < count; index++) {
    const page = doc.addPage([300 + index * 10, 400 + index * 10]);
    page.drawText(`${prefix}${index + 1}`, { x: 30, y: 350, font, size: 14 });
  }
  if (withForm) {
    const field = doc.getForm().createTextField(`${prefix}-field`);
    field.setText('Editable');
    field.addToPage(doc.getPage(0), { x: 30, y: 280, width: 150, height: 24 });
  }
  return new File([(await doc.save()).slice().buffer], name, { type: 'application/pdf', lastModified: 1 });
}

async function open(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({ data: bytes.slice() }).promise;
}

async function pageText(doc: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber);
  return (await page.getTextContent()).items.map((item) => 'str' in item ? item.str : '').join(' ').trim();
}

async function texts(bytes: Uint8Array): Promise<string[]> {
  const doc = await open(bytes);
  try {
    return await Promise.all(Array.from({ length: doc.numPages }, (_, index) => pageText(doc, index + 1)));
  } finally { await doc.destroy(); }
}

function planFor(file: File, count: number): OrganizePlan {
  return createEntries(fileKey(file), count, ids(file.name));
}

describe('Organize PDF', () => {
  it('reverses pages, preserves text, names the output and completes progress', async () => {
    const file = await fixture('sample.pdf', 'A');
    const ctx = context();
    const [output] = await run([file], { plan: [...planFor(file, 4)].reverse() }, ctx);
    expect(await texts(output!.bytes)).toEqual(['A4', 'A3', 'A2', 'A1']);
    expect(output).toMatchObject({ name: 'sample-organized.pdf', mime: 'application/pdf' });
    expect(ctx.onProgress).toHaveBeenLastCalledWith(4, 4, 'Organized PDF ready');
  });

  it('inserts a 300 x 400 blank as page 3', async () => {
    const file = await fixture('sample.pdf', 'A');
    const sourcePlan = planFor(file, 4);
    const plan = insertBlankAfter(sourcePlan, 1, { w: 300, h: 400 }, ids('blank'));
    const [output] = await run([file], { plan }, context());
    const doc = await open(output!.bytes);
    try {
      expect(await pageText(doc, 3)).toBe('');
      expect((await doc.getPage(3)).getViewport({ scale: 1 })).toMatchObject({ width: 300, height: 400 });
    } finally { await doc.destroy(); }
  });

  it('adds a quarter turn to a copied page without losing its text', async () => {
    const file = await fixture('sample.pdf', 'A');
    const plan = planFor(file, 4).map((entry, index) => index === 0 && entry.kind === 'page'
      ? { ...entry, turns: 1 as const } : entry);
    const [output] = await run([file], { plan }, context());
    const doc = await open(output!.bytes);
    try {
      expect((await doc.getPage(1)).rotate).toBe(90);
      expect(await pageText(doc, 1)).toBe('A1');
    } finally { await doc.destroy(); }
  });

  it('interleaves pages from two sources in plan order', async () => {
    const a = await fixture('A.pdf', 'A', 2);
    const b = await fixture('B.pdf', 'B', 2);
    const ap = planFor(a, 2); const bp = planFor(b, 2);
    const plan = [ap[0]!, bp[0]!, ap[1]!, bp[1]!];
    const [output] = await run([a, b], { plan }, context());
    expect(await texts(output!.bytes)).toEqual(['A1', 'B1', 'A2', 'B2']);
  });

  it('copies a duplicated source page twice', async () => {
    const file = await fixture('sample.pdf', 'A', 2);
    const original = planFor(file, 2);
    const plan = [original[0]!, { ...original[0]!, id: 'duplicate' }, original[1]!];
    const [output] = await run([file], { plan }, context());
    expect(await texts(output!.bytes)).toEqual(['A1', 'A1', 'A2']);
  });

  it('guards empty, unchanged and missing-source plans with exact messages', async () => {
    const file = await fixture('sample.pdf', 'A', 2);
    const identity = planFor(file, 2);
    expect(canRun({ plan: [] }, [file])).toBe(EMPTY_PLAN_ERROR);
    expect(canRun({ plan: identity }, [file])).toBe(NO_CHANGE_ERROR);
    rememberPageCount(file, 2);
    expect(canRun({ plan: identity.slice(0, 1) }, [file])).toBeUndefined();
    expect(canRun({ plan: [{ ...identity[0]!, fileKey: 'missing' }] }, [file])).toBe(MISSING_FILE_ERROR);
    await expect(run([file], { plan: [] }, context())).rejects.toThrow(EMPTY_PLAN_ERROR);
    await expect(run([file], { plan: identity }, context())).rejects.toThrow(NO_CHANGE_ERROR);
    await expect(run([file], { plan: [{ ...identity[0]!, fileKey: 'missing' }] }, context()))
      .rejects.toThrow(MISSING_FILE_ERROR);
  });

  it('rejects an already-aborted run before reading a source file', async () => {
    const file = await fixture('sample.pdf', 'A', 2);
    const read = vi.spyOn(file, 'arrayBuffer');
    const controller = new AbortController(); controller.abort();
    await expect(run([file], { plan: movePage(planFor(file, 2), 0, 1) }, context(controller)))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });

  it('copies resources shared between pages only once (no output bloat)', async () => {
    // One image drawn on every page: copying page by page would embed it 20 times.
    const doc = await PDFDocument.create();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const image = await doc.embedPng(Uint8Array.from(Buffer.from(png, 'base64')));
    for (let index = 0; index < 20; index++) {
      doc.addPage([300, 400]).drawImage(image, { x: 20, y: 20, width: 100, height: 100 });
    }
    const inputBytes = await doc.save();
    const file = new File([inputBytes.slice().buffer], 'shared.pdf', { type: 'application/pdf', lastModified: 1 });
    const plan = movePage(planFor(file, 20), 19, 0);
    const [output] = await run([file], { plan: [...plan, { ...plan[0]!, id: 'dup' }] }, context());

    const reopened = await PDFDocument.load(output!.bytes);
    const imageRefs = new Set<string>();
    for (const page of reopened.getPages()) {
      const xObjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      for (const [, value] of xObjects?.entries() ?? []) {
        if (value instanceof PDFRef) imageRefs.add(value.toString());
      }
    }
    expect(reopened.getPageCount()).toBe(21);
    expect(imageRefs.size).toBe(1);
    expect(output!.bytes.byteLength).toBeLessThan(inputBytes.byteLength * 1.5);
  });

  it('warns once when a referenced source contains form fields', async () => {
    const file = await fixture('form.pdf', 'F', 2, true);
    const ctx = context();
    await run([file], { plan: movePage(planFor(file, 2), 0, 1) }, ctx);
    expect(ctx.onWarning).toHaveBeenCalledTimes(1);
    expect(ctx.onWarning).toHaveBeenCalledWith(FORMS_WARNING);
    expect(organizeTool).toMatchObject({ slug: 'organize', accepts: 'pdf', multiple: true, minInputs: 1 });
  });
});
