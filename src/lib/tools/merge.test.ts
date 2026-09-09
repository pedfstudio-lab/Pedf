import { readFileSync } from 'node:fs';
import { degrees, PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { describe, expect, it, vi } from 'vitest';
import { MERGE_FORM_WARNING, MERGE_MIN_FILES_ERROR, mergeTool, run } from './merge';
import { PDF_ERRORS } from './pdfIo';

const sample = (name: string) => new File([readFileSync(`public/samples/${name}`)], name, { type: 'application/pdf' });
const context = () => ({ signal: new AbortController().signal, onProgress: vi.fn(), onWarning: vi.fn() });

async function fileFrom(doc: PDFDocument, name = 'fixture.pdf') {
  return new File([(await doc.save()).slice().buffer], name, { type: 'application/pdf' });
}

async function text(doc: PDFDocumentProxy, number: number) {
  const page = await doc.getPage(number);
  return (await page.getTextContent()).items.map((item) => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim();
}

describe('Merge PDF', () => {
  it.each([false, true])('merges sample + GOA in list order, reversed=%s, preserving geometry and source bytes', async (reversed) => {
    const files = [sample('sample-basic.pdf'), sample('GOA 2026.pdf')];
    if (reversed) files.reverse();
    const originals = await Promise.all(files.map(async (file) => new Uint8Array(await file.arrayBuffer())));
    const docs = await Promise.all(originals.map((data) => getDocument({ data: data.slice() }).promise));
    const ctx = context();
    try {
      const outputs = await run(files, {}, ctx);
      expect(outputs).toHaveLength(1);
      expect(outputs[0]?.name).toBe(reversed ? 'GOA 2026-merged.pdf' : 'sample-basic-merged.pdf');
      const output = await getDocument({ data: outputs[0]!.bytes.slice() }).promise;
      try {
        const [first, last] = docs as [PDFDocumentProxy, PDFDocumentProxy];
        expect(output.numPages).toBe(first.numPages + last.numPages);
        expect(await text(output, 1)).toBe(await text(first, 1));
        expect(await text(output, first.numPages + 1)).toBe(await text(last, 1));
        expect(await text(output, output.numPages)).toBe(await text(last, last.numPages));
        let index = 1;
        for (const doc of docs) {
          for (let pageIndex = 1; pageIndex <= doc.numPages; pageIndex++) {
            const originalPage = await doc.getPage(pageIndex);
            const copiedPage = await output.getPage(index++);
            expect(copiedPage.view).toEqual(originalPage.view);
            expect(copiedPage.rotate).toBe(originalPage.rotate);
          }
        }
      } finally { await output.destroy(); }
      for (const [index, file] of files.entries()) {
        expect(Buffer.compare(Buffer.from(await file.arrayBuffer()), Buffer.from(originals[index]!))).toBe(0);
      }
      expect(ctx.onWarning).not.toHaveBeenCalled();
      expect(ctx.onProgress).toHaveBeenLastCalledWith(2, 2, 'Merged PDF ready');
    } finally { await Promise.all(docs.map((doc) => doc.destroy())); }
  });

  it('preserves mixed page sizes, crop boxes, and rotations', async () => {
    const one = await PDFDocument.create();
    const page = one.addPage([300, 500]); page.setRotation(degrees(90)); page.setCropBox(10, 20, 270, 450);
    const two = await PDFDocument.create(); two.addPage([800, 300]).setRotation(degrees(270));
    const outputs = await run([await fileFrom(one), await fileFrom(two)], {}, context());
    const out = await PDFDocument.load(outputs[0]!.bytes);
    expect(out.getPage(0).getSize()).toEqual({ width: 300, height: 500 });
    expect(out.getPage(0).getCropBox()).toEqual({ x: 10, y: 20, width: 270, height: 450 });
    expect(out.getPage(0).getRotation().angle).toBe(90);
    expect(out.getPage(1).getSize()).toEqual({ width: 800, height: 300 });
    expect(out.getPage(1).getRotation().angle).toBe(270);
  });

  it('uses merged.pdf with more than three inputs and keeps every file, even when repeated', async () => {
    const doc = await PDFDocument.create(); doc.addPage();
    const file = await fileFrom(doc);
    const outputs = await run([file, file, file, file], {}, context());
    expect(outputs[0]?.name).toBe('merged.pdf');
    expect((await PDFDocument.load(outputs[0]!.bytes)).getPageCount()).toBe(4);
  });

  it('requires at least two PDFs in both the definition and direct run', async () => {
    expect(mergeTool.minInputs).toBe(2);
    expect(mergeTool.accepts).toBe('pdf');
    expect(mergeTool.multiple).toBe(true);
    await expect(run([], {}, context())).rejects.toThrow(MERGE_MIN_FILES_ERROR);
    await expect(run([sample('sample-basic.pdf')], {}, context())).rejects.toThrow(MERGE_MIN_FILES_ERROR);
  });

  it('rejects an encrypted input with a friendly error and no completed output', async () => {
    const locked = await PDFDocument.create(); locked.addPage();
    // An encryption dictionary triggers the same parser gate as a password PDF;
    // no real password or encryption key is needed for this regression fixture.
    locked.context.trailerInfo.Encrypt = locked.context.register(locked.context.obj({ Filter: 'Standard' }));
    const ctx = context();
    await expect(run([sample('sample-basic.pdf'), await fileFrom(locked, 'locked.pdf')], {}, ctx)).rejects.toThrow(PDF_ERRORS.encrypted);
    expect(ctx.onProgress.mock.calls.some((call) => call[2] === 'Merged PDF ready')).toBe(false);
  });

  it.each([['broken.pdf', PDF_ERRORS.corrupt], ['notes.txt', PDF_ERRORS.type]])('rejects %s without a partial output', async (name, message) => {
    await expect(run([sample('sample-basic.pdf'), new File(['invalid'], name)], {}, context())).rejects.toThrow(message);
  });

  it('honours cancellation before starting and between files', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(run([], {}, { ...context(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const during = new AbortController();
    const ctx = { ...context(), signal: during.signal };
    ctx.onProgress.mockImplementation((done: number) => { if (done === 1) during.abort(); });
    await expect(run([sample('sample-basic.pdf'), sample('GOA 2026.pdf')], {}, ctx)).rejects.toMatchObject({ name: 'AbortError' });
    expect(ctx.onProgress.mock.calls.some((call) => call[2] === 'Merged PDF ready')).toBe(false);
  });
});

async function formFile(value: string, fieldName = 'name', withSecondWidget = false) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const form = doc.getForm();
  const field = form.createTextField(fieldName); field.setText(value);
  field.addToPage(page, { x: 30, y: 280, width: 230, height: 35 });
  if (withSecondWidget) field.addToPage(doc.addPage([500, 300]), { x: 40, y: 160, width: 230, height: 35 });
  const check = form.createCheckBox('accepted'); check.check();
  check.addToPage(page, { x: 30, y: 230, width: 18, height: 18 });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  form.acroForm.dict.set(PDFName.of('DR'), doc.context.obj({ Font: { SharedFont: font.ref } }));
  form.acroForm.dict.set(PDFName.of('DA'), PDFString.of('/SharedFont 12 Tf 0 g'));
  form.updateFieldAppearances(font);
  field.acroField.setDefaultAppearance('/SharedFont 12 Tf 0 g');
  return fileFrom(doc, `${value}.pdf`);
}

describe('Merge PDF form compatibility', () => {
  it('documents that bare copyPages does not register or automatically rename fields', async () => {
    const input = await PDFDocument.load(await (await formFile('Alice')).arrayBuffer());
    const output = await PDFDocument.create();
    for (const page of await output.copyPages(input, input.getPageIndices())) output.addPage(page);
    expect(output.getForm().getFields()).toHaveLength(0);
    expect(output.getPage(0).node.Annots()?.size()).toBeGreaterThan(0);
  });

  it('warns once and explicitly preserves duplicated editable fields, values and widget page references', async () => {
    const ctx = context();
    const outputs = await run([await formFile('Alice', 'name', true), await formFile('Bob')], {}, ctx);
    expect(ctx.onWarning).toHaveBeenCalledTimes(1);
    expect(ctx.onWarning).toHaveBeenCalledWith(MERGE_FORM_WARNING);
    const output = await PDFDocument.load(outputs[0]!.bytes);
    const form = output.getForm();
    expect(form.getTextField('name').getText()).toBe('Alice');
    expect(form.getTextField('name_2').getText()).toBe('Bob');
    expect(form.getCheckBox('accepted').isChecked()).toBe(true);
    expect(form.getCheckBox('accepted_2').isChecked()).toBe(true);
    expect(form.getTextField('name').acroField.getDefaultAppearance()).toContain('/merge1_SharedFont');
    const fonts = form.acroForm.dict.lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict);
    expect(fonts.has(PDFName.of('merge1_SharedFont'))).toBe(true);
    expect(fonts.has(PDFName.of('merge2_SharedFont'))).toBe(true);
    for (const page of output.getPages()) {
      for (const ref of page.node.Annots()?.asArray() ?? []) {
        const annotation = output.context.lookup(ref, PDFDict);
        if (annotation.get(PDFName.of('Subtype')) === PDFName.of('Widget')) expect(annotation.get(PDFName.of('P'))).toBe(page.ref);
      }
    }
    form.getTextField('name_2').setText('Updated');
    const reopened = await PDFDocument.load(await output.save());
    expect(reopened.getForm().getTextField('name').getText()).toBe('Alice');
    expect(reopened.getForm().getTextField('name_2').getText()).toBe('Updated');
  });

  it('renames colliding root groups without breaking nested field names', async () => {
    const outputs = await run([await formFile('Alice', 'person.name'), await formFile('Bob', 'person.name')], {}, context());
    const form = (await PDFDocument.load(outputs[0]!.bytes)).getForm();
    expect(form.getTextField('person.name').getText()).toBe('Alice');
    expect(form.getTextField('person_2.name').getText()).toBe('Bob');
  });
});
