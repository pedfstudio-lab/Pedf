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
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WATERMARK_OPTIONS } from './watermarkOptions';
import { prepareWatermarkAssets, run, WATERMARK_INPUT_ERROR, watermarkPage, watermarkTool } from './watermark';

function context(controller = new AbortController()) {
  return { signal: controller.signal, onProgress: vi.fn(), onWarning: vi.fn() };
}

async function fixture(name = 'sample.pdf', pageCount = 4) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pageCount; index += 1) {
    const page = doc.addPage([300 + index * 20, 420]);
    page.drawText(`Original page ${index + 1}`, { x: 30, y: 360, font, size: 14 });
    if (index === 2) page.setRotation(degrees(90));
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
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(name, 'ascii'), data]);
  return Buffer.concat([uint32(data.length), body, uint32(crc32(body))]);
}

function rgbPng(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    rows[offset] = 30; rows[offset + 1] = 107; rows[offset + 2] = 255;
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

function contentStreams(doc: PDFDocument, pageIndex: number): string {
  const contents = doc.getPage(pageIndex).node.Contents();
  const streams: (PDFRawStream | PDFContentStream)[] = [];
  if (contents instanceof PDFRawStream || contents instanceof PDFContentStream) streams.push(contents);
  if (contents instanceof PDFArray) for (const item of contents.asArray()) {
    const stream = item instanceof PDFRef ? doc.context.lookup(item) : item;
    if (stream instanceof PDFRawStream || stream instanceof PDFContentStream) streams.push(stream);
  }
  return streams.map((stream) => new TextDecoder().decode(stream instanceof PDFContentStream
    ? stream.getUnencodedContents() : decodePDFRawStream(stream).decode())).join('\n');
}

async function pageText(bytes: Uint8Array, pageNumber: number): Promise<string> {
  const doc = await getDocument({ data: bytes.slice() }).promise;
  try {
    const page = await doc.getPage(pageNumber);
    return (await page.getTextContent()).items.map((item) => 'str' in item ? item.str : '').join(' ');
  } finally { await doc.destroy(); }
}

describe('Watermark PDF', () => {
  it('adds real text to all pages, keeps original content, and reports progress', async () => {
    const ctx = context();
    const [output] = await run([await fixture('report.pdf')], DEFAULT_WATERMARK_OPTIONS, ctx);
    expect(output).toMatchObject({ name: 'report-watermarked.pdf', mime: 'application/pdf' });
    for (let page = 1; page <= 4; page += 1) {
      const text = await pageText(output!.bytes, page);
      expect(text).toContain(`Original page ${page}`);
      expect(text).toContain('CONFIDENTIAL');
    }
    expect(output!.bytes.byteLength).toBeLessThan((await (await fixture()).arrayBuffer()).byteLength + 50 * 1024);
    expect(ctx.onProgress).toHaveBeenLastCalledWith(4, 4, 'Watermarked PDF ready');
  });

  it('watermarks only custom pages and wraps every page layer in exactly one Artifact BDC/EMC pair', async () => {
    const [output] = await run([await fixture()], {
      ...DEFAULT_WATERMARK_OPTIONS, pageSelection: 'custom', ranges: '2-3', position: 'tile',
    }, context());
    const doc = await PDFDocument.load(output!.bytes);
    expect(contentStreams(doc, 0)).not.toContain('/Subtype /Watermark');
    expect(contentStreams(doc, 3)).not.toContain('/Subtype /Watermark');
    for (const pageIndex of [1, 2]) {
      const marked = contentStreams(doc, pageIndex);
      expect(marked.match(/\/Artifact << \/Type \/Pagination \/Subtype \/Watermark >> BDC/g)).toHaveLength(1);
      expect(marked.match(/\bEMC\b/g)).toHaveLength(1);
      expect(marked.match(/\bTj\b/g)?.length ?? 0).toBeGreaterThan(1);
    }

    const pdfjs = await getDocument({ data: output!.bytes.slice() }).promise;
    try {
      const unselected = await (await pdfjs.getPage(1)).getOperatorList();
      expect(unselected.fnArray).not.toContain(OPS.beginMarkedContentProps);
      const selected = await (await pdfjs.getPage(2)).getOperatorList();
      const begin = selected.fnArray.indexOf(OPS.beginMarkedContentProps);
      const end = selected.fnArray.indexOf(OPS.endMarkedContent);
      expect(begin).toBeGreaterThan(-1);
      expect(selected.argsArray[begin]?.[0]).toBe('Artifact');
      expect(end).toBeGreaterThan(begin);
      expect(selected.fnArray.slice(begin + 1, end)).toContain(OPS.showText);
      const markedText = await (await pdfjs.getPage(2)).getTextContent({ includeMarkedContent: true });
      const beginText = markedText.items.findIndex((item) => 'type' in item && item.type === 'beginMarkedContentProps');
      const watermarkText = markedText.items.findIndex((item) => 'str' in item && item.str === 'CONFIDENTIAL');
      const endText = markedText.items.findIndex((item) => 'type' in item && item.type === 'endMarkedContent');
      const originalText = markedText.items.findIndex((item) => 'str' in item && item.str.includes('Original page 2'));
      expect(beginText).toBeGreaterThan(originalText);
      expect(watermarkText).toBeGreaterThan(beginText);
      expect(endText).toBeGreaterThan(watermarkText);
    } finally { await pdfjs.destroy(); }
  });

  it('embeds an image once and reuses it across every selected page', async () => {
    const bytes = rgbPng(8, 4);
    const [output] = await run([await fixture('long.pdf', 20)], {
      ...DEFAULT_WATERMARK_OPTIONS, mode: 'image', imageBytes: bytes, imageMime: 'image/png',
      imageName: 'logo.png', imageWidth: 8, imageHeight: 4,
    }, context());
    const doc = await PDFDocument.load(output!.bytes);
    const imageObjects = doc.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream
      && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
    expect(imageObjects).toHaveLength(1);
    expect(doc.getPageCount()).toBe(20);
    expect(doc.getPages().every((_, index) => contentStreams(doc, index).includes('/Subtype /Watermark'))).toBe(true);
  });

  it('uses one marked-content layer for a tiled page and an opacity graphics state', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const value = { ...DEFAULT_WATERMARK_OPTIONS, position: 'tile' as const, opacity: 0.3 };
    const assets = await prepareWatermarkAssets(doc, value);
    watermarkPage(page, value, assets);
    const content = contentStreams(doc, 0);
    expect(content.match(/\bBDC\b/g)).toHaveLength(1);
    expect(content.match(/\bEMC\b/g)).toHaveLength(1);
    const resources = page.node.Resources();
    const states = resources?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
    expect(states).toBeInstanceOf(PDFDict);
    const opacities = states?.values().map((value) => value instanceof PDFRef ? doc.context.lookup(value, PDFDict) : value)
      .filter((value): value is PDFDict => value instanceof PDFDict)
      .map((state) => state.lookup(PDFName.of('ca'))?.toString());
    expect(opacities).toContain('0.3');
  });

  it.each([0, 90, 180, 270] as const)('puts a dragged spot where the reader sees it on a %i° page', async (rotation) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    page.setRotation(degrees(rotation));
    const value = {
      ...DEFAULT_WATERMARK_OPTIONS, text: 'MARK', size: 24 as const, angle: 0 as const,
      position: 'custom' as const, customX: 0.25, customY: 0.2,
    };
    const geometry = watermarkPage(page, value, await prepareWatermarkAssets(doc, value));
    expect([geometry.pageWidth, geometry.pageHeight]).toEqual(rotation % 180 ? [600, 400] : [400, 600]);

    const pdfjs = await getDocument({ data: (await doc.save()).slice() }).promise;
    try {
      const rendered = await pdfjs.getPage(1);
      const viewport = rendered.getViewport({ scale: 1 });
      const item = (await rendered.getTextContent()).items.find((candidate) => 'str' in candidate && candidate.str === 'MARK');
      if (!item || !('transform' in item)) throw new Error('Watermark text not found.');
      const [a, b, c, d, e, f] = item.transform as number[];
      const along = Math.hypot(a!, b!);
      const up = Math.hypot(c!, d!);
      const centreX = e! + (a! / along) * geometry.itemWidth / 2 + (c! / up) * geometry.itemHeight / 2;
      const centreY = f! + (b! / along) * geometry.itemWidth / 2 + (d! / up) * geometry.itemHeight / 2;
      const [screenX, screenY] = viewport.convertToViewportPoint(centreX, centreY);
      expect(screenX).toBeCloseTo(0.25 * viewport.width, 0);
      expect(screenY).toBeCloseTo(0.2 * viewport.height, 0);
    } finally { await pdfjs.destroy(); }
  });

  it('validates input and options before reading, and exposes the run reason', async () => {
    const file = await fixture();
    await expect(run([], DEFAULT_WATERMARK_OPTIONS, context())).rejects.toThrow(WATERMARK_INPUT_ERROR);
    await expect(run([file, file], DEFAULT_WATERMARK_OPTIONS, context())).rejects.toThrow(WATERMARK_INPUT_ERROR);
    const read = vi.spyOn(file, 'arrayBuffer');
    const invalid = { ...DEFAULT_WATERMARK_OPTIONS, text: '' };
    await expect(run([file], invalid, context())).rejects.toThrow('Type the watermark text first.');
    expect(read).not.toHaveBeenCalled();
    expect(watermarkTool.canRun?.(invalid, [file])).toBe('Type the watermark text first.');
    expect(watermarkTool).toMatchObject({ slug: 'watermark', accepts: 'pdf', multiple: false, icon: '◈' });
  });

  it('stops before reading an input when already aborted', async () => {
    const file = await fixture();
    const read = vi.spyOn(file, 'arrayBuffer');
    const controller = new AbortController(); controller.abort();
    await expect(run([file], DEFAULT_WATERMARK_OPTIONS, context(controller))).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });
});
