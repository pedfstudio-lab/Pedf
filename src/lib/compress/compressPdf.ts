import { PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjs } from '@/lib/pdf/worker';
import { ToolError } from '@/lib/tools/errors';
import { formatBytes } from '@/lib/tools/pdfIo';
import type { ToolOutput } from '@/lib/tools/types';
import { analyzePdf, type CompressAnalysis, type CompressImageAnalysis } from './analyze';
import { decodeCompressImage, decodeCompressSoftMask } from './decode';
import { estimateAllLevels } from './estimate';
import { LEVELS, LEVEL_LADDER, targetSize, type CompressLevel } from './levels';
import { isDocumentScan, isLineArt } from './lineArt';
import { encodeJpeg, recodeImage, resizeSoftMask, type DecodedImagePixels, type JpegEncoder } from './recode';
import { deduplicateImages, replaceImage } from './replace';
import { removeUnusedImages } from './unused';

export const COMPRESS_SAFETY_ERROR = 'We could not compress this file safely. Nothing was changed.';
export const YIELD_EVERY = 4;

export interface CompressResult {
  readonly bytes: Uint8Array;
  readonly levelUsed: CompressLevel;
  readonly madeSmaller: number;
  readonly leftAsTheyWere: number;
  readonly removedUnused: number;
  readonly note?: NonNullable<ToolOutput['note']>;
}

export type CompressDecoder = (
  document: PDFDocument,
  reader: PDFDocumentProxy,
  image: CompressImageAnalysis,
  signal: AbortSignal,
) => Promise<DecodedImagePixels | undefined>;
export type CompressSoftMaskDecoder = (
  document: PDFDocument,
  image: CompressImageAnalysis,
  signal: AbortSignal,
) => Promise<DecodedImagePixels | undefined>;
export type CompressSelfCheck = (bytes: Uint8Array, pageCount: number, signal: AbortSignal) => Promise<boolean>;
export type CompressYield = () => Promise<void>;

export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(0);
  });
}

export interface CompressRunServices {
  readonly signal: AbortSignal;
  readonly onProgress: (done: number, total: number, label: string) => void;
  readonly analysis?: CompressAnalysis;
  readonly encode?: JpegEncoder;
  readonly decode?: CompressDecoder;
  readonly decodeSoftMask?: CompressSoftMaskDecoder;
  readonly selfCheck?: CompressSelfCheck;
  readonly progressPrefix?: string;
  readonly estimates?: Readonly<Record<CompressLevel, number>>;
  readonly yieldWork?: CompressYield;
}

export async function verifyCompressedPdf(bytes: Uint8Array, pageCount: number, signal: AbortSignal): Promise<boolean> {
  let reader: PDFDocumentProxy | undefined;
  try {
    signal.throwIfAborted();
    reader = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    if (reader.numPages !== pageCount) return false;
    for (let pageNumber = 1; pageNumber <= reader.numPages; pageNumber++) {
      signal.throwIfAborted();
      const page = await reader.getPage(pageNumber);
      try { await page.getOperatorList(); } finally { page.cleanup(); }
    }
    return true;
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
    return false;
  } finally { await reader?.destroy(); }
}

function progressLabel(prefix: string | undefined, index: number, total: number): string {
  const photo = `photo ${index + 1} of ${total}`;
  return prefix ? `${prefix} ${photo}` : `Shrinking ${photo}`;
}

function formatLimit(bytes: number): string {
  if (bytes >= 1_000_000 && bytes % 1_000_000 === 0) return `${bytes / 1_000_000} MB`;
  return `${Number((bytes / 1_000).toFixed(2))} KB`;
}

function noChangeNote(
  level: CompressLevel,
  analysis: CompressAnalysis,
  estimates = estimateAllLevels(analysis),
): NonNullable<ToolOutput['note']> {
  const index = LEVEL_LADDER.indexOf(level);
  const next = LEVEL_LADDER.slice(index + 1)
    .find((candidate) => estimates[candidate] < analysis.fileSize * 0.95);
  if (!next) return { text: 'The photos in this file are already as small as we can make them.', tone: 'ok' };
  return {
    text: `The photos in this file are already compressed, so ${LEVELS[level].label} changed nothing. ${LEVELS[next].label} would make it about ${formatBytes(estimates[next])} (photos get a little softer).`,
    tone: 'ok',
  };
}

/** Shrink only understood photo XObjects; text, fonts, vectors, links, forms and annotations are untouched. */
export async function compressPdf(
  bytes: Uint8Array,
  level: CompressLevel,
  services: CompressRunServices,
): Promise<CompressResult> {
  const { signal, onProgress } = services;
  signal.throwIfAborted();
  const analysis = services.analysis ?? await analyzePdf(bytes, signal);
  const candidates = analysis.images.filter((image) => image.shrinkable && image.ref);
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const unused = removeUnusedImages(document, analysis);
  const reader = candidates.length ? await pdfjs.getDocument({ data: bytes.slice() }).promise : undefined;
  const encode = services.encode ?? encodeJpeg;
  const decode = services.decode ?? decodeCompressImage;
  const decodeSoftMask = services.decodeSoftMask ?? decodeCompressSoftMask;
  let madeSmaller = 0;
  try {
    for (let index = 0; index < candidates.length; index++) {
      signal.throwIfAborted();
      onProgress(index, candidates.length, progressLabel(services.progressPrefix, index, candidates.length));
      const image = candidates[index]!;
      try {
        const pixels = await decode(document, reader!, image, signal);
        if (pixels) {
          const lineArt = isLineArt(image, pixels);
          if (lineArt && (image.hasSoftMask || image.hasMask)) continue;
          const gentle = lineArt || (!(image.hasSoftMask || image.hasMask) && isDocumentScan(pixels));
          const dpi = gentle ? Math.max(200, LEVELS[level].dpi) : LEVELS[level].dpi;
          const quality = gentle ? Math.max(0.8, LEVELS[level].quality) : LEVELS[level].quality;
          const target = targetSize(image, dpi);
          const needsResizedMask = image.hasSoftMask &&
            (target.width !== image.width || target.height !== image.height);
          const maskPixels = needsResizedMask ? await decodeSoftMask(document, image, signal) : undefined;
          const jpeg = await recodeImage(pixels, target, quality, encode);
          if (jpeg && image.ref) {
            const replaced = replaceImage(document, image.ref, jpeg, target,
              maskPixels ? resizeSoftMask(maskPixels, target) : undefined);
            if (replaced) madeSmaller += 1;
          }
        }
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        // An image that cannot be decoded or encoded is deliberately left untouched.
      }
      if ((index + 1) % YIELD_EVERY === 0 && index + 1 < candidates.length) {
        await (services.yieldWork ?? yieldToBrowser)();
      }
    }
  } finally { await reader?.destroy(); }
  signal.throwIfAborted();
  const deduplicated = await deduplicateImages(document, signal);
  const compressed = await document.save({ useObjectStreams: true });
  signal.throwIfAborted();
  const checked = await (services.selfCheck ?? verifyCompressedPdf)(compressed, document.getPageCount(), signal);
  if (!checked) throw new ToolError(COMPRESS_SAFETY_ERROR);
  if (compressed.byteLength > bytes.byteLength * 0.95) {
    const changedInternally = madeSmaller > 0 || unused.removed > 0 || deduplicated > 0 || analysis.trailingBytes > 0;
    return {
      bytes,
      levelUsed: level,
      madeSmaller: 0,
      leftAsTheyWere: analysis.photoCount,
      removedUnused: 0,
      note: changedInternally
        ? { text: 'Nothing we could remove made this file more than 5% smaller, so your original is unchanged.', tone: 'ok' }
        : noChangeNote(level, analysis, services.estimates),
    };
  }
  return {
    bytes: compressed,
    levelUsed: level,
    madeSmaller,
    leftAsTheyWere: Math.max(0, analysis.photoCount - madeSmaller),
    removedUnused: unused.removed,
    ...(level === 'smallest' ? {
      note: { text: 'Check that small text is still readable.', tone: 'warn' as const },
    } : {}),
  };
}

export interface FitRunServices extends CompressRunServices {
  readonly estimates?: Readonly<Record<CompressLevel, number>>;
  readonly runLevel?: typeof compressPdf;
}

export async function fitUnderSize(
  bytes: Uint8Array,
  limit: number,
  services: FitRunServices,
): Promise<CompressResult> {
  const { signal } = services;
  signal.throwIfAborted();
  const safeLimit = Math.max(0, Math.floor(limit));
  if (bytes.byteLength <= safeLimit) {
    return {
      bytes,
      levelUsed: 'light',
      madeSmaller: 0,
      leftAsTheyWere: 0,
      removedUnused: 0,
      note: { text: `Already under ${formatLimit(safeLimit)} — nothing to change.`, tone: 'ok' },
    };
  }
  const analysis = services.analysis ?? await analyzePdf(bytes, signal);
  const estimates = services.estimates ?? estimateAllLevels(analysis);
  let start = LEVEL_LADDER.findIndex((level) => estimates[level] <= safeLimit * 0.9);
  if (start < 0) start = LEVEL_LADDER.length - 1;
  const runLevel = services.runLevel ?? compressPdf;
  let smallest: CompressResult | undefined;
  for (let index = start; index < LEVEL_LADDER.length; index++) {
    const level = LEVEL_LADDER[index]!;
    signal.throwIfAborted();
    const result = await runLevel(bytes, level, {
      ...services,
      analysis,
      progressPrefix: `Trying ${LEVELS[level].label}…`,
    });
    if (!smallest || result.bytes.byteLength < smallest.bytes.byteLength) smallest = result;
    if (result.bytes.byteLength <= safeLimit) {
      const check = level === 'smallest' ? ' Check that small text is still readable.' : '';
      return {
        ...result,
        levelUsed: level,
        note: {
          text: `${formatBytes(result.bytes.byteLength)}, under your ${formatLimit(safeLimit)} limit (used ${LEVELS[level].label}).${check}`,
          tone: level === 'smallest' ? 'warn' : 'ok',
        },
      };
    }
  }
  const result = smallest ?? {
    bytes, levelUsed: 'smallest' as const, madeSmaller: 0, leftAsTheyWere: analysis.photoCount, removedUnused: 0,
  };
  return {
    ...result,
    note: {
      text: `The smallest we could make it is ${formatBytes(result.bytes.byteLength)}, over your ${formatLimit(safeLimit)} limit. Try Split PDF to send it in parts.`,
      tone: 'warn',
    },
  };
}
