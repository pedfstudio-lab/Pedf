// @vitest-environment jsdom
import { deflateSync } from 'node:zlib';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HEIC_GUIDANCE } from './files';
import {
  IMAGE_FORMAT_ERROR,
  IMAGE_INPUT_ERROR,
  IMAGE_PAGE_SIZES,
  gridCells,
  imageGridLayout,
  imagePageLayout,
  jpgToPdfTool,
  prepareImageForPdf,
  run,
} from './jpgToPdf';
import { DEFAULT_JPG_TO_PDF_OPTIONS } from './jpgToPdfOptions';

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(name, 'ascii'), data]);
  return Buffer.concat([uint32(data.length), body, uint32(crc32(body))]);
}

function png(width: number, height: number, colour: [number, number, number]): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const start = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const offset = start + 1 + x * 4;
      rows[offset] = colour[0]; rows[offset + 1] = colour[1]; rows[offset + 2] = colour[2]; rows[offset + 3] = 255;
    }
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

function imageFile(name: string, width: number, height: number, colour: [number, number, number]) {
  return new File([Uint8Array.from(png(width, height, colour)).buffer], name, { type: 'image/png' });
}

function context(controller = new AbortController()) {
  return { signal: controller.signal, onProgress: vi.fn(), onWarning: vi.fn() };
}

afterEach(() => vi.restoreAllMocks());

describe('JPG to PDF', () => {
  it('turns three generated PNGs into three centred A4 pages in order', async () => {
    const files = [
      imageFile('red.png', 20, 40, [255, 0, 0]),
      imageFile('green.png', 24, 40, [0, 255, 0]),
      imageFile('blue.png', 30, 40, [0, 0, 255]),
    ];
    const ctx = context();
    const outputs = await run(files, { ...DEFAULT_JPG_TO_PDF_OPTIONS, pageSize: 'a4', margin: 'small' }, ctx);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.name).toBe('images.pdf');
    const pdf = await PDFDocument.load(outputs[0]!.bytes);
    expect(pdf.getPageCount()).toBe(3);
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBeCloseTo(IMAGE_PAGE_SIZES.a4.width, 2);
      expect(page.getHeight()).toBeCloseTo(IMAGE_PAGE_SIZES.a4.height, 2);
      const xObjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      expect(xObjects?.keys()).toHaveLength(1);
    }
    expect(ctx.onProgress).toHaveBeenLastCalledWith(3, 3, 'PDF ready');
  });

  it('auto orientation picks a landscape page for a wide image and keeps it centred', () => {
    const layout = imagePageLayout(400, 200, { ...DEFAULT_JPG_TO_PDF_OPTIONS, pageSize: 'a4', margin: 'small' });
    expect(layout.page.width).toBeCloseTo(IMAGE_PAGE_SIZES.a4.height, 2);
    expect(layout.page.height).toBeCloseTo(IMAGE_PAGE_SIZES.a4.width, 2);
    expect(layout.image.x + layout.image.width / 2).toBeCloseTo(layout.page.width / 2, 5);
    expect(layout.image.y + layout.image.height / 2).toBeCloseTo(layout.page.height / 2, 5);
    expect(layout.image.width / layout.image.height).toBeCloseTo(2, 5);
  });

  it('fit-to-image includes the chosen margin without stretching', () => {
    const layout = imagePageLayout(400, 200, { ...DEFAULT_JPG_TO_PDF_OPTIONS, margin: 'big' });
    expect(layout.page).toEqual({ width: 408, height: 258 });
    expect(layout.image).toEqual({ x: 54, y: 54, width: 300, height: 150 });
  });

  it('uses the image name for one input and images.pdf for several', async () => {
    const one = await run([imageFile('Summer Trip.PNG', 2, 3, [1, 2, 3])], DEFAULT_JPG_TO_PDF_OPTIONS, context());
    expect(one[0]?.name).toBe('Summer Trip.pdf');
  });

  it('uses EXIF-aware bitmap decoding and canvas conversion for WebP', async () => {
    const close = vi.fn();
    const create = vi.fn().mockResolvedValue({ width: 2, height: 1, close });
    vi.stubGlobal('createImageBitmap', create);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const converted = png(2, 1, [10, 20, 30]);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => {
      callback(new Blob([Uint8Array.from(converted).buffer], { type: type ?? 'image/png' }));
    });
    const webp = new File([
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]),
    ], 'photo.webp', { type: 'image/webp' });
    const prepared = await prepareImageForPdf(webp);
    expect(prepared.mime).toBe('image/png');
    expect(create).toHaveBeenCalledWith(expect.any(File), { imageOrientation: 'from-image' });
    expect(drawImage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects missing, unknown and HEIC input with specific messages', async () => {
    await expect(run([], DEFAULT_JPG_TO_PDF_OPTIONS, context())).rejects.toThrow(IMAGE_INPUT_ERROR);
    await expect(run([new File(['GIF89a'], 'wrong.png')], DEFAULT_JPG_TO_PDF_OPTIONS, context())).rejects.toThrow(IMAGE_FORMAT_ERROR);
    const heic = new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])], 'renamed.jpg');
    await expect(run([heic], DEFAULT_JPG_TO_PDF_OPTIONS, context())).rejects.toThrow(HEIC_GUIDANCE);
  });

  it('honours cancellation and leaves its definition configured for ordered images', async () => {
    expect(jpgToPdfTool).toMatchObject({ slug: 'jpg-to-pdf', accepts: 'image', multiple: true });
    const controller = new AbortController(); controller.abort();
    await expect(run([], DEFAULT_JPG_TO_PDF_OPTIONS, context(controller))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('divides a page into 2 or 4 cells with the gap between and around them', () => {
    const stacked = gridCells({ width: 595, height: 842 }, 2, 18);
    expect(stacked).toHaveLength(2);
    expect(stacked[0]!.w).toBeCloseTo(595 - 36, 5);
    expect(stacked[0]!.h).toBeCloseTo((842 - 54) / 2, 5);
    expect(stacked[0]!.y).toBeGreaterThan(stacked[1]!.y);
    expect(stacked[0]!.y + stacked[0]!.h).toBeCloseTo(842 - 18, 5);

    const sideBySide = gridCells({ width: 842, height: 595 }, 2, 0);
    expect(sideBySide[0]!.x).toBe(0);
    expect(sideBySide[1]!.x).toBeCloseTo(421, 5);
    expect(sideBySide[0]!.y).toBeCloseTo(sideBySide[1]!.y, 5);

    const four = gridCells({ width: 595, height: 842 }, 4, 10);
    expect(four).toHaveLength(4);
    expect(four[0]!.w).toBeCloseTo((595 - 30) / 2, 5);
    expect(four[3]!.x).toBeCloseTo(four[1]!.x, 5);
    expect(four[3]!.y).toBeCloseTo(four[2]!.y, 5);
    expect(four[2]!.y).toBeCloseTo(10, 5);

    expect(gridCells({ width: 100, height: 200 }, 1, 5)).toEqual([{ x: 5, y: 5, w: 90, h: 190 }]);
  });

  it('puts four images on the first page and the fifth on its own page', async () => {
    const files = [1, 2, 3, 4, 5].map((n) => imageFile(`p${n}.png`, 20, 30, [n * 40, 0, 0]));
    const outputs = await run(files, { ...DEFAULT_JPG_TO_PDF_OPTIONS, pageSize: 'a4', imagesPerPage: 4 }, context());
    const pdf = await PDFDocument.load(outputs[0]!.bytes);
    expect(pdf.getPageCount()).toBe(2);
    const drawn = (index: number) => pdf.getPage(index).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.keys().length;
    expect(drawn(0)).toBe(4);
    expect(drawn(1)).toBe(1);
  });

  it('auto orientation for grids matches the photos: 2 landscape stack on portrait, 4 landscape get a landscape sheet', () => {
    const wide = { width: 400, height: 200 };
    const two = imageGridLayout([wide, wide], { ...DEFAULT_JPG_TO_PDF_OPTIONS, imagesPerPage: 2 });
    expect(two.page.height).toBeGreaterThan(two.page.width);
    expect(two.images).toHaveLength(2);
    expect(two.images[0]!.y).toBeGreaterThan(two.images[1]!.y);
    const four = imageGridLayout([wide, wide, wide, wide], { ...DEFAULT_JPG_TO_PDF_OPTIONS, imagesPerPage: 4 });
    expect(four.page.width).toBeGreaterThan(four.page.height);
    const tall = { width: 200, height: 400 };
    const twoTall = imageGridLayout([tall, tall], { ...DEFAULT_JPG_TO_PDF_OPTIONS, imagesPerPage: 2 });
    expect(twoTall.page.width).toBeGreaterThan(twoTall.page.height);
  });

  it('warns once, without blocking, when the images add up to more than 100 MB', async () => {
    const file = imageFile('big.png', 2, 2, [0, 0, 0]);
    Object.defineProperty(file, 'size', { value: 120 * 1024 * 1024 });
    const ctx = context();
    const outputs = await run([file], DEFAULT_JPG_TO_PDF_OPTIONS, ctx);
    expect(outputs).toHaveLength(1);
    expect(ctx.onWarning).toHaveBeenCalledTimes(1);
    expect(ctx.onWarning.mock.calls[0]?.[0]).toContain('120 MB');
  });
});
