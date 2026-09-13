import { describe, expect, it, vi } from 'vitest';
import type { CompressAnalysis, CompressImageAnalysis } from './analyze';
import {
  estimatePdfSize,
  predictedImageBytes,
  samplePhotoEstimates,
  selectEstimateSamples,
  type EstimateSamples,
} from './estimate';

function photo(overrides: Partial<CompressImageAnalysis> = {}): CompressImageAnalysis {
  return {
    id: '1', width: 1000, height: 800, filters: ['DCTDecode'], colorSpace: 'DeviceRGB',
    bitsPerComponent: 8, imageMask: false, hasSoftMask: false, hasMask: false,
    streamBytes: 200_000, drawnWidthPt: 240, drawnHeightPt: 192, shrinkable: true, ...overrides,
  };
}

function analysis(images: CompressImageAnalysis[], overrides: Partial<CompressAnalysis> = {}): CompressAnalysis {
  return {
    fileSize: 500_000,
    bytesInShrinkableImages: images.filter((image) => image.shrinkable).reduce((sum, image) => sum + image.streamBytes, 0),
    photoCount: images.filter((image) => image.shrinkable).length,
    skippedCount: images.filter((image) => !image.shrinkable).length,
    trailingBytes: 0,
    unusedPhotoBytes: 0,
    unusedPhotoCount: 0,
    duplicateBytes: 0,
    duplicateCount: 0,
    namesIncomplete: false,
    signed: false,
    images,
    ...overrides,
  };
}

describe('measured compression estimates', () => {
  it('uses the real sample path and a stub encoder that returns 40% of the original', async () => {
    const images = [photo({ id: 'large', streamBytes: 300_000 }), photo({ id: 'small', streamBytes: 100_000 })];
    const source = analysis(images);
    const decode = vi.fn(async (image: CompressImageAnalysis) => ({
      data: Uint8ClampedArray.of(1, 2, 3, 255), width: image.width, height: image.height,
      originalBytes: image.streamBytes,
    }));
    const encode = vi.fn(async (pixels: { originalBytes: number }) => new Uint8Array(Math.floor(pixels.originalBytes * 0.4)));
    const samples = await samplePhotoEstimates(source, decode, encode, new AbortController().signal);
    expect(selectEstimateSamples(source).map((image) => image.id)).toEqual(['large']);
    expect(samples.medium?.[0]).toMatchObject({ imageId: 'large', originalBytes: 300_000, newBytes: 120_000 });
    expect(estimatePdfSize(source, 'medium', samples)).toBe(500_000 - 400_000 + 184_000);
  });

  it('subtracts trailing padding, unused photos and duplicate copies from every estimate', () => {
    const source = analysis([], {
      fileSize: 2_600_000,
      trailingBytes: 1_000_000,
      unusedPhotoBytes: 200_000,
      duplicateBytes: 100_000,
    });
    expect(estimatePdfSize(source, 'light')).toBe(1_300_000);
    expect(estimatePdfSize(source, 'smallest')).toBe(1_300_000);
  });

  it('subtracts a compressed duplicate estimate instead of its original bytes', () => {
    const first = photo({ id: 'first', streamBytes: 400_000 });
    const duplicate = photo({ id: 'duplicate', streamBytes: 400_000 });
    const source = analysis([first, duplicate], { fileSize: 1_000_000, duplicateBytes: 400_000 });
    const samples: EstimateSamples = {
      medium: [
        { imageId: first.id, originalBytes: 400_000, newBytes: 200_000 },
        { imageId: duplicate.id, originalBytes: 400_000, newBytes: 200_000 },
      ],
    };
    expect(estimatePdfSize(source, 'medium', samples)).toBe(400_000);
  });

  it('estimates no whole-file change when sampled photos are kept', () => {
    const image = photo();
    const source = analysis([image]);
    const samples: EstimateSamples = {
      medium: [{ imageId: image.id, originalBytes: image.streamBytes, newBytes: image.streamBytes }],
    };
    expect(estimatePdfSize(source, 'medium', samples)).toBe(source.fileSize);
  });

  it('applies measured bytes per target pixel and the 15% guard to unsampled photos', () => {
    const large = photo({ id: 'large', streamBytes: 300_000 });
    const small = photo({ id: 'small', streamBytes: 100_000 });
    const source = analysis([large, small], { fileSize: 900_000 });
    const samples: EstimateSamples = {
      strong: [{ imageId: 'large', originalBytes: 300_000, newBytes: 150_000 }],
    };
    expect(estimatePdfSize(source, 'strong', samples)).toBe(900_000 - 400_000 + 220_000);
  });

  it('keeps an individual photo when the fallback would save less than 15%', () => {
    const image = photo({ width: 100, height: 100, drawnWidthPt: 72, drawnHeightPt: 72, streamBytes: 1_000 });
    expect(predictedImageBytes(image, 'medium', 0.09)).toBe(1_000);
    expect(predictedImageBytes(image, 'medium', 0.08)).toBe(800);
  });

  it('does not guess savings when a sample cannot be decoded', async () => {
    const image = photo();
    const source = analysis([image]);
    const samples = await samplePhotoEstimates(
      source,
      async () => undefined,
      vi.fn(),
      new AbortController().signal,
    );
    expect(samples.light?.[0]?.newBytes).toBe(image.streamBytes);
    expect(samples.smallest?.[0]?.newBytes).toBe(image.streamBytes);
  });

  it('does not promise savings from transparent lossless line art', async () => {
    const signature = photo({ hasSoftMask: true, filters: ['FlateDecode'] });
    const encode = vi.fn();
    const samples = await samplePhotoEstimates(
      analysis([signature]),
      async () => ({
        data: Uint8ClampedArray.of(0, 0, 0, 0, 255, 255, 255, 255),
        width: 2,
        height: 1,
        originalBytes: signature.streamBytes,
      }),
      encode,
      new AbortController().signal,
    );
    expect(samples.smallest?.[0]?.newBytes).toBe(signature.streamBytes);
    expect(encode).not.toHaveBeenCalled();
  });

  it('estimates a masked photo at its original size when the selected pair fails the combined guard', async () => {
    const masked = photo({ streamBytes: 100_000, hasSoftMask: true, softMaskBytes: 100_000 });
    const source = analysis([masked], { fileSize: 200_000 });
    const samples = await samplePhotoEstimates(
      source,
      async () => ({
        data: new Uint8ClampedArray(Array.from({ length: 256 }, (_, index) =>
          [index, (index * 47) % 256, (index * 89) % 256, 255]).flat()),
        width: 256, height: 1, originalBytes: 100_000,
      }),
      async () => new Uint8Array(80_000),
      new AbortController().signal,
      async () => 120_000,
    );
    expect(samples.smallest?.[0]?.newBytes).toBe(masked.streamBytes);
    expect(estimatePdfSize(source, 'smallest', samples)).toBe(source.fileSize);
  });

  it('estimates a passing pair as its JPEG plus the kept original mask', async () => {
    const masked = photo({ streamBytes: 200_000, hasSoftMask: true, softMaskBytes: 50_000 });
    const source = analysis([masked], { fileSize: 250_000 });
    const samples = await samplePhotoEstimates(
      source,
      async () => ({
        data: new Uint8ClampedArray(Array.from({ length: 256 }, (_, index) =>
          [index, (index * 47) % 256, (index * 89) % 256, 255]).flat()),
        width: 256, height: 1, originalBytes: 200_000,
      }),
      async () => new Uint8Array(100_000),
      new AbortController().signal,
      async () => 60_000,
    );
    expect(samples.smallest?.[0]?.newBytes).toBe(100_000);
    expect(estimatePdfSize(source, 'smallest', samples)).toBe(150_000);
  });

  it('uses the 200 dpi and quality 0.8 floor when sampling a document scan', async () => {
    const scan = photo({ width: 1_000, height: 800, drawnWidthPt: 72, drawnHeightPt: 57.6 });
    const encode = vi.fn(async () => new Uint8Array(100_000));
    await samplePhotoEstimates(
      analysis([scan]),
      async () => ({
        data: new Uint8ClampedArray(Array.from({ length: 2_000 }, (_, index) => {
          const ink = index % 10 === 0;
          const value = ink ? (index * 37) % 76 : 200 + ((index * 17) % 56);
          return [value + 2, value, value - 2, 255];
        }).flat()),
        width: 2_000, height: 1, originalBytes: scan.streamBytes,
      }),
      encode,
      new AbortController().signal,
    );
    expect(encode).toHaveBeenLastCalledWith(expect.anything(),
      { width: 200, height: 160, scale: 0.2 }, 0.8);
  });

  it('keeps a Smallest honesty reserve when samples cover under half of the photo bytes', () => {
    const images = [photo({ id: 'one' }), photo({ id: 'two' }), photo({ id: 'three' })];
    const source = analysis(images, { fileSize: 700_000 });
    const samples: EstimateSamples = {
      smallest: [{ imageId: 'one', originalBytes: 200_000, newBytes: 100_000 }],
    };
    expect(estimatePdfSize(source, 'smallest', samples)).toBe(448_001);
  });
});
