// @vitest-environment jsdom
import { PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { ToolError } from './errors';
import {
  REPAIR_INPUT_ERROR,
  SIGNATURE_WARNING,
  TOO_DAMAGED_ERROR,
  repairLadder,
  run,
  tryRebuildPages,
  tryRewriteIndex,
  verifyPdf,
  type RepairAttempt,
} from './repair';
import { inspectPdf } from './repairInspect';
import type { ToolContext } from './types';

vi.mock('@/lib/pdf/worker', async () => ({ pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs') }));

function context(controller = new AbortController()): ToolContext {
  return { signal: controller.signal, onProgress: vi.fn(), onWarning: vi.fn() };
}

async function fixture(pageCount = 2): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pageCount; index += 1) {
    document.addPage([300, 400]).drawText(`Repair fixture page ${index + 1}`, { x: 30, y: 340, font });
  }
  return document.save({ useObjectStreams: false });
}

function file(bytes: Uint8Array, name = 'source.pdf'): File {
  return new File([bytes.slice().buffer], name, { type: 'application/pdf', lastModified: 10 });
}

function chopped(bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes).toString('latin1');
  const xref = text.lastIndexOf('\nxref\n');
  if (xref < 0) throw new Error('fixture has no xref table');
  return bytes.slice(0, xref);
}

describe('repair ladder and tool', () => {
  it('repairs a chopped xref with the first try and keeps selectable text', async () => {
    const damaged = chopped(await fixture(2));
    const inspection = await inspectPdf(damaged);
    expect(inspection.kind).toBe('damaged');
    const result = await tryRewriteIndex(damaged, inspection, context());
    expect(result?.note.text).toContain('All 2 pages kept');
    expect(result && await verifyPdf(result.bytes)).toMatchObject({ ok: true, pageCount: 2, badPages: [] });
    const rebuilt = await PDFDocument.load(result!.bytes);
    expect(rebuilt.getPageCount()).toBe(2);
  });

  it('moves through injected tries, keeps their exact notes, and rejects unverifiable output', async () => {
    const second: RepairAttempt = {
      bytes: new Uint8Array([2]), promisedPageCount: 2,
      note: {
        text: 'Rebuilt page by page. 1 of 3 pages kept as they were. Page 2 became an image. Page 3 could not be read.',
        tone: 'warn',
      },
    };
    const tries = [vi.fn(async () => undefined), vi.fn(async () => second), vi.fn(async () => undefined)];
    const verify = vi.fn(async () => ({ ok: true, pageCount: 2, badPages: [] as number[] }));
    expect(await repairLadder(tries, verify, context())).toBe(second);
    expect(tries[2]).not.toHaveBeenCalled();
    expect(second.note.text).toContain('Page 2 became an image. Page 3 could not be read.');

    await expect(repairLadder([async () => second], async () => ({ ok: false, pageCount: 2, badPages: [0] }), context()))
      .rejects.toEqual(new ToolError(TOO_DAMAGED_ERROR));
  });

  it('uses the all-picture danger note when only the last fallback verifies', async () => {
    const pictures: RepairAttempt = {
      bytes: new Uint8Array([3]), promisedPageCount: 1,
      note: {
        text: "Text became images: every page is now a picture. It opens everywhere, but text can't be selected, searched, edited or read aloud.",
        tone: 'danger',
      },
    };
    const result = await repairLadder(
      [async () => undefined, async () => undefined, async () => pictures],
      async () => ({ ok: true, pageCount: 1, badPages: [] }),
      context(),
    );
    expect(result.note.tone).toBe('danger');
    expect(result.note.text).toContain("text can't be selected");
  });

  it('rebuilds shared image resources with one bulk copy and avoids output bloat', async () => {
    const document = await PDFDocument.create();
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const image = await document.embedPng(Uint8Array.from(Buffer.from(png, 'base64')));
    for (let index = 0; index < 12; index += 1) {
      document.addPage([300, 400]).drawImage(image, { x: 20, y: 20, width: 100, height: 100 });
    }
    const bytes = await document.save();
    const inspection = await inspectPdf(bytes);
    const result = await tryRebuildPages(bytes, inspection, context());
    expect(result).toBeDefined();
    expect(result?.note.text).toContain('12 of 12 pages kept as they were');
    expect(result && await verifyPdf(result.bytes)).toMatchObject({ ok: true, pageCount: 12 });
    const reopened = await PDFDocument.load(result!.bytes);
    const imageRefs = new Set<string>();
    for (const page of reopened.getPages()) {
      const xObjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      for (const [, value] of xObjects?.entries() ?? []) {
        if (value instanceof PDFRef) imageRefs.add(value.toString());
      }
    }
    expect(imageRefs.size).toBe(1);
    expect(result!.bytes.byteLength).toBeLessThan(bytes.byteLength * 1.5);
  });

  it('rejects random PDF-looking bytes, healthy files without consent, and the wrong input count', async () => {
    await expect(run([file(new TextEncoder().encode('%PDF-1.7 random bytes'))], {}, context()))
      .rejects.toEqual(new ToolError(TOO_DAMAGED_ERROR));
    await expect(run([file(await fixture(1))], {}, context()))
      .rejects.toEqual(new ToolError('This file looks healthy — no repair needed.'));
    await expect(run([file(await fixture(1)), file(await fixture(1), 'second.pdf')], {}, context()))
      .rejects.toEqual(new ToolError(REPAIR_INPUT_ERROR));
  });

  it('warns when rewriting a signed file after consent', async () => {
    const bytes = await fixture(1);
    const text = Buffer.from(bytes).toString('latin1');
    const signed = Uint8Array.from(Buffer.from(text.replace('%%EOF', '/FT /Sig /ByteRange [0 1 2 3]\n%%EOF'), 'latin1'));
    const ctx = context();
    const outputs = await run([file(signed, 'signed.pdf')], { repairAnyway: true, acceptSignatureLoss: true }, ctx);
    expect(ctx.onWarning).toHaveBeenCalledWith(SIGNATURE_WARNING);
    expect(outputs[0]?.name).toBe('signed-repaired.pdf');
  });

  it('honours an already-aborted signal before reading the file', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run([file(await fixture(1))], { repairAnyway: true }, context(controller)))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
