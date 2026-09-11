import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { inspectPdf } from './repairInspect';

vi.mock('@/lib/pdf/worker', async () => ({ pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs') }));

async function fixture(pages = 2): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) document.addPage().drawText(`Readable page ${index + 1}`);
  return document.save({ useObjectStreams: false });
}

describe('inspectPdf', () => {
  it('recognises a healthy PDF and reports page progress', async () => {
    const progress: Array<[number, number]> = [];
    const inspection = await inspectPdf(await fixture(2), (done, total) => progress.push([done, total]));
    expect(inspection).toEqual({ kind: 'healthy', pageCount: 2, signed: false });
    expect(progress.at(-1)).toEqual([2, 2]);
  });

  it('rejects HTML or random content before invoking either PDF parser', async () => {
    expect(await inspectPdf(new TextEncoder().encode('<html>not a PDF</html>'))).toEqual({ kind: 'not-pdf' });
  });

  it('recognises an Encrypt trailer entry as locked rather than damaged', async () => {
    const text = Buffer.from(await fixture(1)).toString('latin1');
    const marker = 'trailer\n<<';
    const position = text.indexOf(marker);
    expect(position).toBeGreaterThan(-1);
    const locked = `${text.slice(0, position + marker.length)}\n/Encrypt << /Filter /Standard >>${text.slice(position + marker.length)}`;
    expect(await inspectPdf(Uint8Array.from(Buffer.from(locked, 'latin1')))).toEqual({ kind: 'locked' });
  });

  it('marks a file with its xref/trailer tail chopped off as damaged', async () => {
    const bytes = await fixture(2);
    const text = Buffer.from(bytes).toString('latin1');
    const xref = text.lastIndexOf('\nxref\n');
    expect(xref).toBeGreaterThan(-1);
    const inspection = await inspectPdf(bytes.slice(0, xref));
    expect(inspection.kind).toBe('damaged');
    if (inspection.kind === 'damaged') expect(inspection.problems).toContain("the file's index is broken");
  });

  it('detects a signature dictionary without validating the signature', async () => {
    const document = await PDFDocument.create();
    document.addPage();
    const value = document.context.obj({
      Type: PDFName.of('Sig'),
      ByteRange: [0, 1, 2, 3],
      Contents: PDFHexString.of('00'),
    });
    const field = document.context.obj({ FT: PDFName.of('Sig'), V: value });
    document.catalog.set(PDFName.of('AcroForm'), document.context.obj({ Fields: [field] }));
    const inspection = await inspectPdf(await document.save({ useObjectStreams: false }));
    expect('signed' in inspection && inspection.signed).toBe(true);
  });
});
