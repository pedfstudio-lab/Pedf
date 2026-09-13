import { PDFDocument } from 'pdf-lib';
import { pdfjs } from '@/lib/pdf/worker';
import type { CompressAnalysis, CompressImageAnalysis } from './analyze';
import { decodeCompressImage, decodeCompressSoftMask } from './decode';
import { LEVELS, LEVEL_LADDER, targetSize, type CompressLevel } from './levels';
import { isDocumentScan, isLineArt } from './lineArt';
import { encodeJpeg, recodeImage, resizeSoftMask, type DecodedImagePixels, type JpegEncoder } from './recode';
import { replacementClearsCombinedGuard, resizedSoftMaskStream } from './replace';

export const FALLBACK_BYTES_PER_PIXEL: Readonly<Record<CompressLevel, number>> = {
  light: 0.25,
  medium: 0.15,
  strong: 0.11,
  smallest: 0.09,
};

export interface EstimateSample {
  readonly imageId: string;
  readonly originalBytes: number;
  readonly newBytes: number;
}

export type EstimateSamples = Readonly<Partial<Record<CompressLevel, readonly EstimateSample[]>>>;
export type EstimateDecoder = (
  image: CompressImageAnalysis,
  signal: AbortSignal,
) => Promise<DecodedImagePixels | undefined>;
export type EstimateMaskSizer = (
  image: CompressImageAnalysis,
  target: { width: number; height: number },
  signal: AbortSignal,
) => Promise<number | undefined>;

export function predictedImageBytes(
  image: CompressImageAnalysis,
  level: CompressLevel,
  bytesPerPixel = FALLBACK_BYTES_PER_PIXEL[level],
): number {
  if (!image.shrinkable) return image.streamBytes;
  const target = targetSize(image, LEVELS[level].dpi);
  const predicted = Math.ceil(target.width * target.height * Math.max(0, bytesPerPixel));
  return predicted <= image.streamBytes * 0.85 ? predicted : image.streamBytes;
}

export function selectEstimateSamples(analysis: CompressAnalysis): CompressImageAnalysis[] {
  const photos = analysis.images.filter((image) => image.shrinkable)
    .sort((left, right) => right.streamBytes - left.streamBytes);
  const targetBytes = analysis.bytesInShrinkableImages * 0.4;
  const selected: CompressImageAnalysis[] = [];
  let covered = 0;
  for (const photo of photos) {
    if (selected.length >= 6 || (selected.length > 0 && covered >= targetBytes)) break;
    selected.push(photo);
    covered += photo.streamBytes;
  }
  return selected;
}

/** Run the real target-size and JPEG-quality path on a byte-weighted sample of this file's photos. */
export async function samplePhotoEstimates(
  analysis: CompressAnalysis,
  decode: EstimateDecoder,
  encode: JpegEncoder,
  signal: AbortSignal,
  sizeResizedMask?: EstimateMaskSizer,
): Promise<EstimateSamples> {
  const outcomes: Record<CompressLevel, EstimateSample[]> = {
    light: [], medium: [], strong: [], smallest: [],
  };
  for (const image of selectEstimateSamples(analysis)) {
    signal.throwIfAborted();
    let pixels: DecodedImagePixels | undefined;
    try { pixels = await decode(image, signal); } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    }
    for (const level of LEVEL_LADDER) {
      signal.throwIfAborted();
      let newBytes: number;
      // A decode failure gives us no honest measurement; only an encoder failure uses the documented fallback.
      if (!pixels) newBytes = image.streamBytes;
      else {
        const lineArt = isLineArt(image, pixels);
        if (lineArt && (image.hasSoftMask || image.hasMask)) {
          outcomes[level].push({ imageId: image.id, originalBytes: image.streamBytes, newBytes: image.streamBytes });
          continue;
        }
        const gentle = lineArt || (!(image.hasSoftMask || image.hasMask) && isDocumentScan(pixels));
        try {
          const dpi = gentle ? Math.max(200, LEVELS[level].dpi) : LEVELS[level].dpi;
          const quality = gentle ? Math.max(0.8, LEVELS[level].quality) : LEVELS[level].quality;
          const target = targetSize(image, dpi);
          const encoded = await recodeImage(pixels, target, quality, encode);
          newBytes = encoded?.byteLength ?? image.streamBytes;
          if (encoded && image.hasSoftMask) {
            const originalMaskBytes = image.softMaskBytes ?? 0;
            let chosenMaskBytes = originalMaskBytes;
            const needsResizedMask = target.width !== image.width || target.height !== image.height;
            if (needsResizedMask && sizeResizedMask) {
              let resizedMaskBytes: number | undefined;
              try { resizedMaskBytes = await sizeResizedMask(image, target, signal); } catch (error) {
                if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
              }
              if (resizedMaskBytes !== undefined && resizedMaskBytes < originalMaskBytes) {
                chosenMaskBytes = resizedMaskBytes;
              }
            }
            newBytes = replacementClearsCombinedGuard(
              image.streamBytes, originalMaskBytes, encoded.byteLength, chosenMaskBytes,
            ) ? encoded.byteLength + chosenMaskBytes - originalMaskBytes : image.streamBytes;
          }
        } catch (error) {
          if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
          newBytes = gentle ? image.streamBytes : predictedImageBytes(image, level);
        }
      }
      outcomes[level].push({ imageId: image.id, originalBytes: image.streamBytes, newBytes });
    }
  }
  return outcomes;
}

function predictedPhotoBytes(
  analysis: CompressAnalysis,
  level: CompressLevel,
  samples: EstimateSamples,
): number {
  const photos = analysis.images.filter((image) => image.shrinkable);
  const outcomes = samples[level];
  if (!outcomes?.length) return photos.reduce((sum, image) => sum + predictedImageBytes(image, level), 0);
  const sampledIds = new Set(outcomes.map((sample) => sample.imageId));
  const originalSampleBytes = outcomes.reduce((sum, sample) => sum + sample.originalBytes, 0);
  const newSampleBytes = outcomes.reduce((sum, sample) => sum + sample.newBytes, 0);
  const changedSamples = outcomes.flatMap((sample) => {
    const image = photos.find((photo) => photo.id === sample.imageId);
    return image && sample.newBytes < sample.originalBytes ? [{ image, sample }] : [];
  });
  if (!changedSamples.length) {
    return newSampleBytes + photos.filter((image) => !sampledIds.has(image.id))
      .reduce((sum, image) => sum + image.streamBytes, 0);
  }
  const measuredPixels = changedSamples.reduce((sum, { image }) => {
    const target = targetSize(image, LEVELS[level].dpi);
    return sum + target.width * target.height;
  }, 0);
  const measuredBytes = changedSamples.reduce((sum, { sample }) => sum + sample.newBytes, 0);
  const measuredBytesPerPixel = measuredPixels > 0 ? measuredBytes / measuredPixels : FALLBACK_BYTES_PER_PIXEL[level];
  const unsampled = photos.filter((image) => !sampledIds.has(image.id));
  const pixelProjection = unsampled
    .reduce((sum, image) => sum + predictedImageBytes(image, level, measuredBytesPerPixel), 0);
  const sampleRatio = originalSampleBytes > 0 ? newSampleBytes / originalSampleBytes : 1;
  const ratioProjection = unsampled.reduce((sum, image) => sum + image.streamBytes, 0) * sampleRatio;
  // Source-byte ratios model JPEG compressibility; target-pixel rates model resolution and the per-photo guard.
  // Blend both because either signal alone is systematically optimistic for a mixed set of large and small photos.
  return Math.round(newSampleBytes + ratioProjection * 0.6 + pixelProjection * 0.4);
}

export function estimatePdfSize(
  analysis: CompressAnalysis,
  level: CompressLevel,
  samples: EstimateSamples = {},
): number {
  const predicted = predictedPhotoBytes(analysis, level, samples);
  const predictedDuplicateBytes = analysis.bytesInShrinkableImages > 0
    ? Math.min(analysis.duplicateBytes,
      analysis.duplicateBytes * predicted / analysis.bytesInShrinkableImages)
    : analysis.duplicateBytes;
  const estimate = Math.max(0,
    analysis.fileSize
    - analysis.trailingBytes
    - analysis.unusedPhotoBytes
    - analysis.bytesInShrinkableImages
    + predicted
    - predictedDuplicateBytes,
  );
  const outcomes = samples[level];
  const sampledBytes = outcomes?.reduce((sum, sample) => sum + sample.originalBytes, 0) ?? 0;
  const coverage = analysis.bytesInShrinkableImages > 0 ? sampledBytes / analysis.bytesInShrinkableImages : 1;
  // At Smallest, unsampled document scans can retain substantially more bytes than sampled photos.
  // Keep a modest honesty reserve only when the measured sample covers less than half of all photo bytes.
  return level === 'smallest' && outcomes?.length && coverage < 0.5
    ? Math.min(analysis.fileSize, Math.ceil(estimate * 1.12))
    : estimate;
}

export function estimateAllLevels(
  analysis: CompressAnalysis,
  samples: EstimateSamples = {},
): Record<CompressLevel, number> {
  return Object.fromEntries(
    LEVEL_LADDER.map((level) => [level, estimatePdfSize(analysis, level, samples)]),
  ) as Record<CompressLevel, number>;
}

const estimateCache = new WeakMap<File, Promise<Record<CompressLevel, number>>>();

/** Browser estimates measured from up to six representative photos and cached once per File. */
export function estimateFileLevels(
  file: File,
  analysis: CompressAnalysis,
  signal: AbortSignal,
): Promise<Record<CompressLevel, number>> {
  signal.throwIfAborted();
  let cached = estimateCache.get(file);
  if (!cached) {
    cached = (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const document = await PDFDocument.load(bytes, { updateMetadata: false });
      const reader = await pdfjs.getDocument({ data: bytes.slice() }).promise;
      try {
        const samples = await samplePhotoEstimates(
          analysis,
          (image, sampleSignal) => decodeCompressImage(document, reader, image, sampleSignal),
          encodeJpeg,
          signal,
          async (image, target, sampleSignal) => {
            const maskPixels = await decodeCompressSoftMask(document, image, sampleSignal);
            if (!maskPixels) return undefined;
            return resizedSoftMaskStream(document, resizeSoftMask(maskPixels, target), target).contents.length;
          },
        );
        return estimateAllLevels(analysis, samples);
      } finally { await reader.destroy(); }
    })();
    estimateCache.set(file, cached);
    void cached.catch(() => { if (estimateCache.get(file) === cached) estimateCache.delete(file); });
  }
  return cached.then((result) => { signal.throwIfAborted(); return result; });
}
