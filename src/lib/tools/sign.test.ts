// @vitest-environment jsdom
import { deflateSync } from 'node:zlib';
import {
  decodePDFRawStream,
  degrees,
  PDFArray,
  PDFContentStream,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  StandardFonts,
} from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SIGN_OPTIONS, formatSignDate } from './signOptions';
import { run, SIGN_INPUT_ERROR, signTool } from './sign';

function context(controller = new AbortController()) {
  return { signal: controller.signal, onProgress: vi.fn(), onWarning: vi.fn() };
}

async function fixture(name = 'agreement.pdf', pageCount = 4) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pageCount; index++) {
    const page = doc.addPage([300, 420]);
    page.drawText(`Original page ${index + 1}`, { x: 30, y: 360, font, size: 14 });
  }
  return new File([(await doc.save()).slice().buffer], name, { type: 'application/pdf' });
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value >>> 0); return bytes;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(name, 'ascii'), data]);
  return Buffer.concat([uint32(data.length), body, uint32(crc32(body))]);
}

function signaturePng(width = 40, height = 12): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    rows[offset] = 12; rows[offset + 1] = 24; rows[offset + 2] = 54;
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

function options(extra = {}) {
  return { ...DEFAULT_SIGN_OPTIONS, signature: { png: signaturePng(), width: 40, height: 12 }, ...extra };
}

function pageHasImage(doc: PDFDocument, pageIndex: number): boolean {
  const resources = doc.getPage(pageIndex).node.Resources();
  const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  return !!xobjects?.values().some((object) => {
    const resolved = doc.context.lookup(object);
    return resolved instanceof PDFRawStream && resolved.dict.get(PDFName.of('Subtype')) === PDFName.of('Image');
  });
}

function pageContent(doc: PDFDocument, pageIndex: number): string {
  const contents = doc.getPage(pageIndex).node.Contents();
  const streams: Array<PDFRawStream | PDFContentStream> = [];
  if (contents instanceof PDFRawStream || contents instanceof PDFContentStream) streams.push(contents);
  if (contents instanceof PDFArray) for (const item of contents.asArray()) {
    const stream = item instanceof PDFRef ? doc.context.lookup(item) : item;
    if (stream instanceof PDFRawStream || stream instanceof PDFContentStream) streams.push(stream);
  }
  return streams.map((stream) => new TextDecoder().decode(stream instanceof PDFContentStream
    ? stream.getUnencodedContents() : decodePDFRawStream(stream).decode())).join('\n');
}

type Matrix = [number, number, number, number, number, number];
function multiply(left: Matrix, right: Matrix): Matrix {
  const [a, b, c, d, e, f] = left;
  const [g, h, i, j, k, l] = right;
  return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
}

function drawnImageCentre(doc: PDFDocument): { x: number; y: number } {
  const lines = pageContent(doc, 0).split(/\r?\n/).map((line) => line.trim());
  const draw = lines.findIndex((line) => /^\/\S+\s+Do$/.test(line));
  if (draw < 0) throw new Error('signature draw operator not found');
  let begin = draw;
  while (begin >= 0 && lines[begin] !== 'q') begin -= 1;
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  for (const line of lines.slice(begin + 1, draw)) {
    const match = line.match(/^(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm$/);
    if (match) matrix = multiply(matrix, match.slice(1).map(Number) as Matrix);
  }
  return { x: matrix[0] * 0.5 + matrix[2] * 0.5 + matrix[4], y: matrix[1] * 0.5 + matrix[3] * 0.5 + matrix[5] };
}

async function pageText(bytes: Uint8Array, pageNumber: number): Promise<string> {
  const doc = await getDocument({ data: bytes.slice() }).promise;
  try {
    return (await (await doc.getPage(pageNumber)).getTextContent()).items
      .map((item) => 'str' in item ? item.str : '').join(' ');
  } finally { await doc.destroy(); }
}

describe('Sign PDF', () => {
  it('signs one chosen page and keeps all original content', async () => {
    const ctx = context();
    const [output] = await run([await fixture('rent.pdf')], options({ pageIndex: 2 }), ctx);
    expect(output).toMatchObject({ name: 'rent-signed.pdf', mime: 'application/pdf' });
    const doc = await PDFDocument.load(output!.bytes);
    expect(doc.getPageCount()).toBe(4);
    expect(doc.getPages().map((_, index) => pageHasImage(doc, index))).toEqual([false, false, true, false]);
    expect(await pageText(output!.bytes, 3)).toContain('Original page 3');
    expect(ctx.onProgress).toHaveBeenLastCalledWith(1, 1, 'Signed PDF ready');
  });

  it('embeds the PNG once when signing every page and adds the date under it', async () => {
    const [output] = await run([await fixture('initials.pdf', 20)], options({ pageSelection: 'all', date: 'text' }), context());
    const doc = await PDFDocument.load(output!.bytes);
    const images = doc.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream
      && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
    expect(images).toHaveLength(1);
    expect(doc.getPages().every((_, index) => pageHasImage(doc, index))).toBe(true);
    expect(await pageText(output!.bytes, 1)).toContain(formatSignDate('text'));
    expect(await pageText(output!.bytes, 20)).toContain(formatSignDate('text'));
  });

  it('signs only the pages in a custom range', async () => {
    const [output] = await run([await fixture()], options({ pageSelection: 'custom', ranges: '2, 4' }), context());
    const doc = await PDFDocument.load(output!.bytes);
    expect(doc.getPages().map((_, index) => pageHasImage(doc, index))).toEqual([false, true, false, true]);
  });

  it.each([0, 90, 180, 270] as const)('uses the displayed page frame on a %i degree page', async (rotation) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    page.setRotation(degrees(rotation));
    const file = new File([(await doc.save()).slice().buffer], 'turned.pdf', { type: 'application/pdf' });
    const [output] = await run([file], options({ x: 0.25, y: 0.2 }), context());
    const loaded = await PDFDocument.load(output!.bytes);
    expect(pageHasImage(loaded, 0)).toBe(true);
    const centre = drawnImageCentre(loaded);
    const pdfjs = await getDocument({ data: output!.bytes.slice() }).promise;
    try {
      const page = await pdfjs.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const [screenX, screenY] = viewport.convertToViewportPoint(centre.x, centre.y);
      expect(screenX).toBeCloseTo(0.25 * viewport.width, 0);
      expect(screenY).toBeCloseTo(0.2 * viewport.height, 0);
    } finally { await pdfjs.destroy(); }
  });

  it('validates before reading and stops immediately when aborted', async () => {
    const file = await fixture();
    await expect(run([], options(), context())).rejects.toThrow(SIGN_INPUT_ERROR);
    await expect(run([file, file], options(), context())).rejects.toThrow(SIGN_INPUT_ERROR);
    const read = vi.spyOn(file, 'arrayBuffer');
    await expect(run([file], DEFAULT_SIGN_OPTIONS, context())).rejects.toThrow('Make or pick a signature first.');
    expect(read).not.toHaveBeenCalled();
    expect(signTool.canRun?.(DEFAULT_SIGN_OPTIONS, [file])).toBe('Make or pick a signature first.');
    const controller = new AbortController(); controller.abort();
    await expect(run([file], options(), context(controller))).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });
});
