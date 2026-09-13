// @vitest-environment jsdom
import {
  concatTransformationMatrix,
  drawObject,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  popGraphicsState,
  pushGraphicsState,
  StandardFonts,
} from 'pdf-lib';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CompressAnalysis, CompressImageAnalysis } from './analyze';
import { COMPRESS_SAFETY_ERROR, compressPdf, fitUnderSize, type CompressResult } from './compressPdf';

vi.mock('@/lib/pdf/worker', async () => ({ pdfjs: await import('pdfjs-dist/legacy/build/pdf.mjs') }));

interface Fixture { bytes: Uint8Array; analysis: CompressAnalysis }

async function fixture(imageCount = 1, otherBytes = 0, withSoftMask = false): Promise<Fixture> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const page = document.addPage([300, 400]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText('Text stays selectable', { x: 20, y: 360, size: 12, font });
  const images: CompressImageAnalysis[] = [];
  for (let index = 0; index < imageCount; index++) {
    const contents = new Uint8Array(400 * 300 * 3).fill(90 + index);
    const maskRef = withSoftMask ? document.context.register(PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 400, Height: 300,
      ColorSpace: 'DeviceGray', BitsPerComponent: 8,
    }), new Uint8Array(400 * 300).fill(255))) : undefined;
    const stream = PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 400, Height: 300,
      ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
      ...(maskRef ? { SMask: maskRef } : {}),
    }), contents);
    const ref = document.context.register(stream);
    const name = page.node.newXObject(`Photo${index}`, ref);
    page.pushOperators(
      pushGraphicsState(), concatTransformationMatrix(200, 0, 0, 150, 30, 120), drawObject(name), popGraphicsState(),
    );
    images.push({
      id: ref.toString(), ref: { objectNumber: ref.objectNumber, generationNumber: ref.generationNumber },
      width: 400, height: 300, filters: [], colorSpace: 'DeviceRGB', components: 3, bitsPerComponent: 8,
      imageMask: false, hasSoftMask: withSoftMask, hasMask: false, streamBytes: contents.length,
      drawnWidthPt: 200, drawnHeightPt: 150, effectiveDpi: 144,
      occurrence: { pageIndex: 0, rect: { x: 30, y: 120, w: 200, h: 150 } }, shrinkable: true,
    });
  }
  if (otherBytes > 0) {
    const other = PDFRawStream.of(document.context.obj({ Type: 'TaskData' }), new Uint8Array(otherBytes).fill(11));
    document.catalog.set(PDFName.of('TaskData'), document.context.register(other));
  }
  const bytes = await document.save({ useObjectStreams: true });
  return {
    bytes,
    analysis: {
      fileSize: bytes.byteLength,
      bytesInShrinkableImages: images.reduce((sum, image) => sum + image.streamBytes, 0),
      photoCount: images.length,
      skippedCount: 0,
      trailingBytes: 0, unusedPhotoBytes: 0, unusedPhotoCount: 0, duplicateBytes: 0, duplicateCount: 0,
      namesIncomplete: false, signed: false,
      images,
    },
  };
}

const smoothPhotoData = new Uint8ClampedArray(256 * 4);
for (let index = 0; index < 256; index++) {
  smoothPhotoData.set([index, (index * 47) % 256, (index * 89) % 256, 255], index * 4);
}
const decode = vi.fn(async (_document, _reader, image: CompressImageAnalysis) => ({
  data: smoothPhotoData, width: image.width, height: image.height, originalBytes: image.streamBytes,
}));
const encode = vi.fn(async () => new Uint8Array(4_000).fill(7));

beforeAll(() => { vi.clearAllMocks(); });

describe('Compress PDF pipeline', () => {
  it('shrinks photo objects while preserving the page and text objects', async () => {
    const source = await fixture();
    const progress = vi.fn();
    const result = await compressPdf(source.bytes, 'medium', {
      signal: new AbortController().signal, onProgress: progress, analysis: source.analysis,
      decode, encode, selfCheck: async () => true,
    });
    expect(result.bytes.byteLength).toBeLessThan(source.bytes.byteLength);
    expect(result).toMatchObject({ levelUsed: 'medium', madeSmaller: 1, leftAsTheyWere: 0 });
    expect(progress).toHaveBeenCalledWith(0, 1, 'Shrinking photo 1 of 1');
    const reopened = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(reopened.getPageCount()).toBe(1);
  });

  it('runs visible Smallest at 80 dpi and quality 0.5 with a readability note', async () => {
    const source = await fixture();
    const smallestEncode = vi.fn(async () => new Uint8Array(4_000).fill(7));
    const result = await compressPdf(source.bytes, 'smallest', {
      signal: new AbortController().signal, onProgress: vi.fn(), analysis: source.analysis,
      decode, encode: smallestEncode, selfCheck: async () => true,
    });
    expect(smallestEncode).toHaveBeenCalledWith(expect.anything(), { width: 222, height: 167, scale: expect.any(Number) }, 0.5);
    expect(result.note).toEqual({ text: 'Check that small text is still readable.', tone: 'warn' });
  });

  it('resizes a soft mask with its Smallest photo at 8-bit precision', async () => {
    const source = await fixture(1, 0, true);
    const smoothData = new Uint8ClampedArray(256 * 4);
    for (let index = 0; index < 256; index++) {
      smoothData.set([index, (index * 47) % 256, (index * 89) % 256, 128], index * 4);
    }
    const smoothDecode = vi.fn(async (_document, _reader, image: CompressImageAnalysis) => ({
      data: smoothData, width: 256, height: 1, originalBytes: image.streamBytes,
    }));
    const photoAnalysis: CompressAnalysis = {
      ...source.analysis,
      images: source.analysis.images.map((image) => ({ ...image, filters: ['DCTDecode'] })),
    };
    const decodeSoftMask = vi.fn(async () => ({
      data: new Uint8ClampedArray(400 * 300 * 4).fill(255),
      width: 400,
      height: 300,
      originalBytes: 120_000,
    }));
    const photoEncode = vi.fn(async () => new Uint8Array(4_000));
    const result = await compressPdf(source.bytes, 'smallest', {
      signal: new AbortController().signal, onProgress: vi.fn(), analysis: photoAnalysis,
      decode: smoothDecode, decodeSoftMask, encode: photoEncode, selfCheck: async () => true,
    });
    expect(decodeSoftMask).toHaveBeenCalledTimes(1);
    expect(photoEncode).toHaveBeenCalledWith(expect.anything(),
      { width: 222, height: 167, scale: expect.any(Number) }, 0.5);
    const reopened = await PDFDocument.load(result.bytes, { updateMetadata: false });
    const main = reopened.context.enumerateIndirectObjects().map(([, object]) => object)
      .find((object): object is PDFRawStream => object instanceof PDFRawStream
        && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')
        && object.dict.get(PDFName.of('ColorSpace')) === PDFName.of('DeviceRGB'));
    const maskRef = main?.dict.get(PDFName.of('SMask'));
    expect(maskRef).toBeInstanceOf(PDFRef);
    if (!(maskRef instanceof PDFRef)) throw new Error('soft mask missing');
    const mask = reopened.context.lookup(maskRef);
    expect(mask).toBeInstanceOf(PDFRawStream);
    if (!(mask instanceof PDFRawStream)) throw new Error('soft mask stream missing');
    expect(mask.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(222);
    expect(mask.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber()).toBe(167);
    expect(mask.dict.lookup(PDFName.of('BitsPerComponent'), PDFNumber).asNumber()).toBe(8);
  });

  it('keeps the original soft mask and still replaces the photo when the mask cannot be decoded', async () => {
    const source = await fixture(1, 0, true);
    const photoAnalysis: CompressAnalysis = {
      ...source.analysis,
      images: source.analysis.images.map((image) => ({ ...image, filters: ['DCTDecode'] })),
    };
    const decodeSoftMask = vi.fn(async () => undefined);
    const result = await compressPdf(source.bytes, 'smallest', {
      signal: new AbortController().signal, onProgress: vi.fn(), analysis: photoAnalysis,
      decode, decodeSoftMask, encode, selfCheck: async () => true,
    });
    expect(result.madeSmaller).toBe(1);
    expect(decodeSoftMask).toHaveBeenCalledTimes(1);
    const reopened = await PDFDocument.load(result.bytes, { updateMetadata: false });
    const main = reopened.context.enumerateIndirectObjects().map(([, object]) => object)
      .find((object): object is PDFRawStream => object instanceof PDFRawStream
        && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')
        && object.dict.get(PDFName.of('ColorSpace')) === PDFName.of('DeviceRGB'));
    const maskRef = main?.dict.get(PDFName.of('SMask'));
    expect(maskRef).toBeInstanceOf(PDFRef);
    if (!(maskRef instanceof PDFRef)) throw new Error('soft mask missing');
    const mask = reopened.context.lookup(maskRef);
    expect(mask).toBeInstanceOf(PDFRawStream);
    if (!(mask instanceof PDFRawStream)) throw new Error('soft mask stream missing');
    expect(mask.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(400);
    expect(mask.dict.lookup(PDFName.of('Height'), PDFNumber).asNumber()).toBe(300);
  });

  it('leaves lossless line art with transparency byte-identical at every level', async () => {
    const source = await fixture(1, 0, true);
    const lineArtDecode = vi.fn(async (_document, _reader, image: CompressImageAnalysis) => ({
      data: Uint8ClampedArray.of(0, 0, 0, 0, 255, 255, 255, 255),
      width: 2, height: 1, originalBytes: image.streamBytes,
    }));
    const lineArtEncode = vi.fn(async () => new Uint8Array(4_000));
    for (const level of ['light', 'medium', 'strong', 'smallest'] as const) {
      const result = await compressPdf(source.bytes, level, {
        signal: new AbortController().signal, onProgress: vi.fn(), analysis: source.analysis,
        decode: lineArtDecode, encode: lineArtEncode, selfCheck: async () => true,
      });
      expect(result.bytes).toBe(source.bytes);
      expect(result.madeSmaller).toBe(0);
      expect(result.leftAsTheyWere).toBe(1);
    }
    expect(lineArtEncode).not.toHaveBeenCalled();
  });

  it('compresses an opaque document scan at no less than 200 dpi and quality 0.8', async () => {
    const source = await fixture();
    const scanDecode = vi.fn(async (_document, _reader, image: CompressImageAnalysis) => ({
      data: new Uint8ClampedArray(Array.from({ length: 2_000 }, (_, index) => {
        const ink = index % 10 === 0;
        const value = ink ? (index * 37) % 76 : 200 + ((index * 17) % 56);
        return [value + 2, value, value - 2, 255];
      }).flat()),
      width: 2_000, height: 1, originalBytes: image.streamBytes,
    }));
    const scanEncode = vi.fn(async () => new Uint8Array(4_000));
    const result = await compressPdf(source.bytes, 'smallest', {
      signal: new AbortController().signal, onProgress: vi.fn(), analysis: source.analysis,
      decode: scanDecode, encode: scanEncode, selfCheck: async () => true,
    });
    expect(scanEncode).toHaveBeenCalledWith(expect.anything(), { width: 400, height: 300, scale: 1 }, 0.8);
    expect(result.madeSmaller).toBe(1);
  });

  it('returns the exact original when there are no useful savings', async () => {
    const document = await PDFDocument.create(); document.addPage();
    const bytes = await document.save();
    const result = await compressPdf(bytes, 'medium', {
      signal: new AbortController().signal, onProgress: vi.fn(),
      analysis: { fileSize: bytes.length, bytesInShrinkableImages: 0, photoCount: 0, skippedCount: 0,
        trailingBytes: 0, unusedPhotoBytes: 0, unusedPhotoCount: 0, duplicateBytes: 0, duplicateCount: 0,
        namesIncomplete: false, signed: false, images: [] },
      estimates: { light: bytes.length, medium: bytes.length, strong: bytes.length, smallest: bytes.length / 2 },
    });
    expect(result.bytes).toBe(bytes);
    expect(result.note?.text).toContain('Medium changed nothing');
    expect(result.note?.text).toContain('Smallest would make it about');
    expect(result.note?.text).not.toContain('Strong would make it about');
  });

  it('explains when real image savings do not clear the whole-file 5% threshold', async () => {
    const source = await fixture(1, 1_000_000);
    const barelySmaller = vi.fn(async (pixels: { originalBytes: number }) =>
      new Uint8Array(Math.floor(pixels.originalBytes * 0.84)).fill(7));
    const result = await compressPdf(source.bytes, 'medium', {
      signal: new AbortController().signal, onProgress: vi.fn(), analysis: source.analysis,
      decode, encode: barelySmaller, selfCheck: async () => true,
    });
    expect(result.bytes).toBe(source.bytes);
    expect(result.note?.text).toBe('Nothing we could remove made this file more than 5% smaller, so your original is unchanged.');
  });

  it('uses the terminal already-small message at Smallest', async () => {
    const document = await PDFDocument.create(); document.addPage();
    const bytes = await document.save();
    const result = await compressPdf(bytes, 'smallest', {
      signal: new AbortController().signal, onProgress: vi.fn(),
      analysis: { fileSize: bytes.length, bytesInShrinkableImages: 0, photoCount: 0, skippedCount: 0,
        trailingBytes: 0, unusedPhotoBytes: 0, unusedPhotoCount: 0, duplicateBytes: 0, duplicateCount: 0,
        namesIncomplete: false, signed: false, images: [] },
    });
    expect(result.note?.text).toBe('The photos in this file are already as small as we can make them.');
  });

  it('removes independently-confirmed unused images before compression and still self-checks', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([200, 200]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText('Lossless cleanup', { x: 20, y: 160, font, size: 12 });
    const stream = PDFRawStream.of(document.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 300, Height: 300,
      ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    }), new Uint8Array(270_000).fill(80));
    const ref = document.context.register(stream);
    page.node.newXObject('Unused', ref);
    const bytes = await document.save({ useObjectStreams: true });
    const unusedImage: CompressImageAnalysis = {
      id: ref.toString(), ref: { objectNumber: ref.objectNumber, generationNumber: ref.generationNumber },
      width: 300, height: 300, filters: [], colorSpace: 'DeviceRGB', bitsPerComponent: 8,
      imageMask: false, hasSoftMask: false, hasMask: false, streamBytes: 270_000,
      drawnWidthPt: 0, drawnHeightPt: 0, shrinkable: false, skipReason: 'never drawn',
    };
    const result = await compressPdf(bytes, 'light', {
      signal: new AbortController().signal, onProgress: vi.fn(),
      analysis: {
        fileSize: bytes.length, bytesInShrinkableImages: 0, photoCount: 0, skippedCount: 1,
        trailingBytes: 0, unusedPhotoBytes: 270_000, unusedPhotoCount: 1, duplicateBytes: 0, duplicateCount: 0,
        namesIncomplete: false, signed: false, images: [unusedImage],
      },
    });
    expect(result.removedUnused).toBe(1);
    expect(result.bytes.byteLength).toBeLessThan(bytes.byteLength * 0.95);
    const reopened = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(reopened.context.enumerateIndirectObjects().some(([, object]) => object instanceof PDFRawStream
      && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'))).toBe(false);
  });

  it('rejects a failed self-check and stops between photos when aborted', async () => {
    const one = await fixture();
    await expect(compressPdf(one.bytes, 'strong', {
      signal: new AbortController().signal, onProgress: vi.fn(), analysis: one.analysis,
      decode, encode, selfCheck: async () => false,
    })).rejects.toThrow(COMPRESS_SAFETY_ERROR);

    const two = await fixture(2);
    const controller = new AbortController();
    await expect(compressPdf(two.bytes, 'medium', {
      signal: controller.signal,
      onProgress: (done) => { if (done === 0) controller.abort(); },
      analysis: two.analysis, decode, encode, selfCheck: async () => true,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports every photo and yields to the browser after each group of four', async () => {
    const source = await fixture(9);
    const progress = vi.fn();
    const yieldWork = vi.fn(async () => undefined);
    await compressPdf(source.bytes, 'medium', {
      signal: new AbortController().signal,
      onProgress: progress,
      analysis: source.analysis,
      decode,
      encode,
      selfCheck: async () => true,
      yieldWork,
    });
    expect(progress).toHaveBeenCalledTimes(9);
    expect(yieldWork).toHaveBeenCalledTimes(2);
  });
});

describe('fit under a portal limit', () => {
  const bytes = new Uint8Array(1_000);
  const analysis: CompressAnalysis = {
    fileSize: 1_000, bytesInShrinkableImages: 500, photoCount: 1, skippedCount: 0, signed: false, images: [],
    trailingBytes: 0, unusedPhotoBytes: 0, unusedPhotoCount: 0, duplicateBytes: 0, duplicateCount: 0,
    namesIncomplete: false,
  };
  const result = (size: number, levelUsed: CompressResult['levelUsed']): CompressResult => ({
    bytes: new Uint8Array(size), levelUsed, madeSmaller: 1, leftAsTheyWere: 0, removedUnused: 0,
  });

  it('starts at the gentlest estimated level that fits', async () => {
    const runLevel = vi.fn(async (_bytes, level) => result(480, level));
    const fitted = await fitUnderSize(bytes, 500, {
      signal: new AbortController().signal, onProgress: vi.fn(), analysis,
      estimates: { light: 400, medium: 300, strong: 200, smallest: 100 }, runLevel,
    });
    expect(runLevel.mock.calls.map(([, level]) => level)).toEqual(['light']);
    expect(fitted.note?.text).toContain('under your 0.5 KB limit (used Light)');
  });

  it('tries the next stronger level when the first result is over', async () => {
    const runLevel = vi.fn(async (_bytes, level) => result(level === 'medium' ? 600 : 450, level));
    const fitted = await fitUnderSize(bytes, 500, {
      signal: new AbortController().signal, onProgress: vi.fn(), analysis,
      estimates: { light: 900, medium: 400, strong: 300, smallest: 200 }, runLevel,
    });
    expect(runLevel.mock.calls.map(([, level]) => level)).toEqual(['medium', 'strong']);
    expect(fitted.levelUsed).toBe('strong');
  });

  it('returns the smallest honest result when no level fits, and skips work when already under', async () => {
    const runLevel = vi.fn(async (_bytes, level) => result(700, level));
    const tooLarge = await fitUnderSize(bytes, 500, {
      signal: new AbortController().signal, onProgress: vi.fn(), analysis,
      estimates: { light: 900, medium: 800, strong: 700, smallest: 600 }, runLevel,
    });
    expect(runLevel.mock.calls.map(([, level]) => level)).toEqual(['smallest']);
    expect(tooLarge.note).toMatchObject({ tone: 'warn' });
    expect(tooLarge.note?.text).toContain('Try Split PDF');

    runLevel.mockClear();
    const already = await fitUnderSize(new Uint8Array(400), 500, {
      signal: new AbortController().signal, onProgress: vi.fn(), analysis, runLevel,
    });
    expect(runLevel).not.toHaveBeenCalled();
    expect(already.note?.text).toContain('Already under 0.5 KB');
  });
});
