import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import { imageDrawsInContent, matchImageXObject } from '@/lib/images/extractImage';
import { imageDrawsFromOperatorList, type DrawnImage } from '@/lib/pdf/images';
import type { PdfRect } from '@/lib/export/types';
import { pdfjs } from '@/lib/pdf/worker';
import { hasDigitalSignature } from '@/lib/tools/repairInspect';
import { imageDeduplicationHash } from './replace';

export type CompressSkipReason =
  | 'image mask'
  | 'used as a mask'
  | '1-bit image'
  | 'black-and-white scan'
  | 'under 64 px'
  | 'has a colour-key or stencil mask'
  | 'unsupported colour space'
  | 'never drawn'
  | 'cannot be matched to a ref'
  | 'inline image';

export interface ImageReference { readonly objectNumber: number; readonly generationNumber: number }
export interface ImageOccurrence {
  readonly pageIndex: number;
  readonly rect: PdfRect;
  readonly objectId?: string;
}

export interface CompressImageAnalysis {
  readonly id: string;
  readonly ref?: ImageReference;
  readonly width: number;
  readonly height: number;
  readonly filters: readonly string[];
  readonly colorSpace: string;
  readonly components?: number;
  readonly bitsPerComponent?: number;
  readonly imageMask: boolean;
  readonly hasSoftMask: boolean;
  readonly softMaskBytes?: number;
  readonly hasMask: boolean;
  readonly streamBytes: number;
  readonly drawnWidthPt: number;
  readonly drawnHeightPt: number;
  readonly effectiveDpi?: number;
  readonly occurrence?: ImageOccurrence;
  readonly shrinkable: boolean;
  readonly skipReason?: CompressSkipReason;
}

export interface CompressAnalysis {
  readonly fileSize: number;
  readonly bytesInShrinkableImages: number;
  readonly photoCount: number;
  readonly skippedCount: number;
  readonly trailingBytes: number;
  readonly unusedPhotoBytes: number;
  readonly unusedPhotoCount: number;
  readonly duplicateBytes: number;
  readonly duplicateCount: number;
  readonly namesIncomplete: boolean;
  readonly signed: boolean;
  readonly images: readonly CompressImageAnalysis[];
}

interface MutableImage {
  id: string;
  ref?: ImageReference;
  stream: PDFRawStream;
  width: number;
  height: number;
  filters: string[];
  colorSpace: string;
  components?: number;
  bitsPerComponent?: number;
  imageMask: boolean;
  hasSoftMask: boolean;
  softMaskBytes?: number;
  hasMask: boolean;
  streamBytes: number;
  drawnWidthPt: number;
  drawnHeightPt: number;
  occurrence?: ImageOccurrence;
  xObjectBound: boolean;
}

function refKey(ref: PDFRef): string {
  return `${ref.objectNumber}:${ref.generationNumber}`;
}

const EOF_MARKER = Uint8Array.of(0x25, 0x25, 0x45, 0x4f, 0x46);

function whitespace(byte: number): boolean {
  return byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

/** Count non-standard bytes after the last %%EOF, ignoring the normal trailing line break. */
export function trailingByteCount(bytes: Uint8Array): number {
  let marker = -1;
  // Search backwards in 2 KB windows so even unusually large padding after %%EOF is found without copying it.
  for (let windowEnd = bytes.length; windowEnd > 0 && marker < 0; windowEnd -= 2_048) {
    const windowStart = Math.max(0, windowEnd - 2_048 - EOF_MARKER.length + 1);
    for (let index = Math.min(windowEnd - EOF_MARKER.length, bytes.length - EOF_MARKER.length); index >= windowStart; index--) {
      if (EOF_MARKER.every((byte, offset) => bytes[index + offset] === byte)) {
        marker = index;
        break;
      }
    }
  }
  if (marker < 0) return 0;
  let contentEnd = marker + EOF_MARKER.length;
  while (contentEnd < bytes.length && whitespace(bytes[contentEnd]!)) contentEnd += 1;
  return contentEnd === bytes.length ? 0 : bytes.length - contentEnd;
}

async function duplicateTotals(images: readonly MutableImage[], signal: AbortSignal): Promise<{ bytes: number; count: number }> {
  const seen = new Set<string>();
  let bytes = 0;
  let count = 0;
  for (const image of images.filter((candidate) => candidate.xObjectBound)) {
    signal.throwIfAborted();
    const hash = await imageDeduplicationHash(image.stream);
    if (seen.has(hash)) {
      bytes += image.streamBytes;
      count += 1;
    } else seen.add(hash);
  }
  return { bytes, count };
}

function resolve(document: PDFDocument, object: PDFObject | undefined): PDFObject | undefined {
  return object instanceof PDFRef ? document.context.lookup(object) : object;
}

function filterNames(document: PDFDocument, dict: PDFDict): string[] {
  const filter = resolve(document, dict.get(PDFName.of('Filter')));
  if (!filter) return [];
  if (filter instanceof PDFName) return [filter.decodeText()];
  if (!(filter instanceof PDFArray)) return [];
  const names: string[] = [];
  for (let index = 0; index < filter.size(); index++) {
    const item = resolve(document, filter.get(index));
    if (item instanceof PDFName) names.push(item.decodeText());
  }
  return names;
}

function colourSpace(
  document: PDFDocument,
  object: PDFObject | undefined,
): { label: string; components?: number; supported: boolean } {
  const resolved = resolve(document, object);
  if (resolved instanceof PDFName) {
    const label = resolved.decodeText();
    if (label === 'DeviceGray' || label === 'G') return { label: 'DeviceGray', components: 1, supported: true };
    if (label === 'DeviceRGB' || label === 'RGB') return { label: 'DeviceRGB', components: 3, supported: true };
    return { label, supported: false };
  }
  if (!(resolved instanceof PDFArray) || resolved.size() === 0) return { label: 'Unknown', supported: false };
  const family = resolve(document, resolved.get(0));
  const name = family instanceof PDFName ? family.decodeText() : 'Unknown';
  if (name === 'ICCBased') {
    const profile = resolve(document, resolved.get(1));
    const components = profile instanceof PDFStream
      ? profile.dict.lookupMaybe(PDFName.of('N'), PDFNumber)?.asNumber() : undefined;
    return { label: 'ICCBased', components, supported: components === 1 || components === 3 };
  }
  if (name === 'Indexed' || name === 'I') {
    const base = colourSpace(document, resolved.get(1));
    return { label: `Indexed/${base.label}`, components: base.components, supported: base.supported };
  }
  return { label: name, supported: false };
}

function collectResources(document: PDFDocument): MutableImage[] {
  const images = new Map<string, MutableImage>();
  const direct: MutableImage[] = [];
  const visitedFormRefs = new Set<string>();
  const visitedDirectForms = new Set<PDFStream>();

  const collect = (stream: PDFRawStream, ref?: PDFRef, xObjectBound = false): MutableImage => {
    const key = ref ? refKey(ref) : '';
    const existing = key ? images.get(key) : direct.find((image) => image.stream === stream);
    if (existing) {
      if (xObjectBound) existing.xObjectBound = true;
      return existing;
    }
    const width = stream.dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber() ?? 0;
    const height = stream.dict.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber() ?? 0;
    const space = colourSpace(document, stream.dict.get(PDFName.of('ColorSpace')));
    const softMask = resolve(document, stream.dict.get(PDFName.of('SMask')));
    const image: MutableImage = {
      id: key || `direct-${direct.length + 1}`,
      ...(ref ? { ref: { objectNumber: ref.objectNumber, generationNumber: ref.generationNumber } } : {}),
      stream,
      width,
      height,
      filters: filterNames(document, stream.dict),
      colorSpace: space.label,
      ...(space.components === undefined ? {} : { components: space.components }),
      bitsPerComponent: stream.dict.lookupMaybe(PDFName.of('BitsPerComponent'), PDFNumber)?.asNumber(),
      imageMask: stream.dict.lookupMaybe(PDFName.of('ImageMask'), PDFBool)?.asBoolean() ?? false,
      hasSoftMask: !!stream.dict.get(PDFName.of('SMask')),
      ...(softMask instanceof PDFRawStream ? { softMaskBytes: softMask.contents.length } : {}),
      hasMask: !!stream.dict.get(PDFName.of('Mask')),
      streamBytes: stream.contents.length,
      drawnWidthPt: 0,
      drawnHeightPt: 0,
      xObjectBound,
    };
    if (key) images.set(key, image); else direct.push(image);
    for (const name of ['SMask', 'Mask']) {
      const rawMask = stream.dict.get(PDFName.of(name));
      const mask = resolve(document, rawMask);
      if (mask instanceof PDFRawStream) collect(mask, rawMask instanceof PDFRef ? rawMask : undefined);
    }
    return image;
  };

  const walk = (resources: PDFDict | undefined) => {
    const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xObjects) return;
    for (const name of xObjects.keys()) {
      const raw = xObjects.get(name);
      const object = resolve(document, raw);
      if (!(object instanceof PDFStream)) continue;
      const subtype = object.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
      if (subtype === 'Image' && object instanceof PDFRawStream) collect(object, raw instanceof PDFRef ? raw : undefined, true);
      if (subtype !== 'Form') continue;
      if (raw instanceof PDFRef) {
        const key = refKey(raw);
        if (visitedFormRefs.has(key)) continue;
        visitedFormRefs.add(key);
      } else {
        if (visitedDirectForms.has(object)) continue;
        visitedDirectForms.add(object);
      }
      walk(object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources);
    }
  };
  for (const page of document.getPages()) walk(page.node.Resources());
  return [...images.values(), ...direct];
}

function imageRef(image: MutableImage): PDFRef | undefined {
  return image.ref ? PDFRef.of(image.ref.objectNumber, image.ref.generationNumber) : undefined;
}

function referencedMaskKeys(images: readonly MutableImage[]): Set<string> {
  const result = new Set<string>();
  for (const image of images) {
    for (const name of ['SMask', 'Mask']) {
      const value = image.stream.dict.get(PDFName.of(name));
      if (value instanceof PDFRef) result.add(refKey(value));
    }
  }
  return result;
}

function skipReason(image: MutableImage, usedAsMask: Set<string>, supportedColour: boolean): CompressSkipReason | undefined {
  if (image.imageMask) return 'image mask';
  const ref = imageRef(image);
  if (ref && usedAsMask.has(refKey(ref))) return 'used as a mask';
  if (image.bitsPerComponent === 1) return '1-bit image';
  if (image.filters.some((filter) => ['CCITTFaxDecode', 'CCF', 'JBIG2Decode'].includes(filter))) return 'black-and-white scan';
  if (image.width < 64 || image.height < 64) return 'under 64 px';
  if (image.hasMask) return 'has a colour-key or stencil mask';
  if (!supportedColour) return 'unsupported colour space';
  if (!image.ref) return 'cannot be matched to a ref';
  if (!image.occurrence || image.drawnWidthPt <= 0 || image.drawnHeightPt <= 0) return 'never drawn';
}

function rectanglesNear(left: PdfRect, right: PdfRect): boolean {
  const tolerance = 0.5;
  return Math.abs(left.x - right.x) <= tolerance
    && Math.abs(left.y - right.y) <= tolerance
    && Math.abs(left.w - right.w) <= tolerance
    && Math.abs(left.h - right.h) <= tolerance;
}

function matchingReaderDraw(
  draws: readonly DrawnImage[],
  used: Set<number>,
  rect: PdfRect,
  imageMask: boolean,
): DrawnImage | undefined {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < draws.length; index++) {
    const draw = draws[index]!;
    if (used.has(index) || draw.kind !== (imageMask ? 'mask' : 'image') || !rectanglesNear(draw.region.rect, rect)) continue;
    const distance = Math.abs(draw.region.rect.x - rect.x) + Math.abs(draw.region.rect.y - rect.y)
      + Math.abs(draw.region.rect.w - rect.w) + Math.abs(draw.region.rect.h - rect.h);
    if (distance < bestDistance) { bestIndex = index; bestDistance = distance; }
  }
  if (bestIndex < 0) return undefined;
  used.add(bestIndex);
  return draws[bestIndex];
}

function creditDraw(
  image: MutableImage,
  pageIndex: number,
  rect: PdfRect,
  widthPt: number,
  heightPt: number,
  objectId?: string,
): void {
  const previousArea = image.drawnWidthPt * image.drawnHeightPt;
  image.drawnWidthPt = Math.max(image.drawnWidthPt, widthPt);
  image.drawnHeightPt = Math.max(image.drawnHeightPt, heightPt);
  if (!image.occurrence || widthPt * heightPt > previousArea) {
    image.occurrence = {
      pageIndex,
      rect,
      ...(objectId ? { objectId } : {}),
    };
  }
}

/** Inspect image XObjects and how large they are actually drawn without changing the PDF. */
export async function analyzePdf(bytes: Uint8Array, signal: AbortSignal): Promise<CompressAnalysis> {
  signal.throwIfAborted();
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const mutable = collectResources(document);
  const byRef = new Map<string, MutableImage>(mutable.flatMap((image) => image.ref
    ? [[`${image.ref.objectNumber}:${image.ref.generationNumber}`, image] as [string, MutableImage]] : []));
  const extras: CompressImageAnalysis[] = [];
  let namesIncomplete = false;
  const reader = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  try {
    for (let pageIndex = 0; pageIndex < reader.numPages; pageIndex++) {
      signal.throwIfAborted();
      const page = await reader.getPage(pageIndex + 1);
      try {
        const readerDraws = imageDrawsFromOperatorList(
          await page.getOperatorList(), page.getViewport({ scale: 1 }), pageIndex,
        );
        for (const draw of readerDraws.filter((entry) => entry.kind === 'inline')) {
          extras.push({
            id: `inline-${pageIndex}-${extras.length}`,
            width: 0, height: 0, filters: [], colorSpace: 'Unknown', imageMask: false,
            hasSoftMask: false, hasMask: false, streamBytes: 0,
            drawnWidthPt: draw.widthPt, drawnHeightPt: draw.heightPt,
            occurrence: { pageIndex, rect: draw.region.rect }, shrinkable: false, skipReason: 'inline image',
          });
        }
        const contentDraws = imageDrawsInContent(document, pageIndex);
        if (contentDraws) {
          const usedReaderDraws = new Set<number>();
          for (const draw of contentDraws) {
            const image = draw.ref ? byRef.get(refKey(draw.ref))
              : mutable.find((candidate) => candidate.stream === draw.stream);
            if (!image) continue;
            const readerDraw = matchingReaderDraw(readerDraws, usedReaderDraws, draw.rect, image.imageMask);
            creditDraw(image, pageIndex, draw.rect, draw.widthPt, draw.heightPt, readerDraw?.objectId);
          }
        } else {
          namesIncomplete = true;
          for (const draw of readerDraws) {
            if (draw.kind === 'inline') continue;
            const matched = matchImageXObject(document, pageIndex, draw.region.rect);
            const matchedKey = matched?.ref ? refKey(matched.ref) : undefined;
            const image = matchedKey ? byRef.get(matchedKey)
              : mutable.find((candidate) => candidate.stream === matched?.stream);
            if (image) creditDraw(image, pageIndex, draw.region.rect, draw.widthPt, draw.heightPt, draw.objectId);
          }
        }
      } finally { page.cleanup(); }
      if ((pageIndex + 1) % 10 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally { await reader.destroy(); }

  const masks = referencedMaskKeys(mutable);
  const images = mutable.map<CompressImageAnalysis>((image) => {
    const space = colourSpace(document, image.stream.dict.get(PDFName.of('ColorSpace')));
    const reason = skipReason(image, masks, space.supported);
    const effectiveDpi = image.drawnWidthPt > 0 && image.drawnHeightPt > 0
      ? Math.max(image.width * 72 / image.drawnWidthPt, image.height * 72 / image.drawnHeightPt) : undefined;
    return {
      id: image.id,
      ...(image.ref ? { ref: image.ref } : {}),
      width: image.width,
      height: image.height,
      filters: image.filters,
      colorSpace: image.colorSpace,
      ...(image.components === undefined ? {} : { components: image.components }),
      ...(image.bitsPerComponent === undefined ? {} : { bitsPerComponent: image.bitsPerComponent }),
      imageMask: image.imageMask,
      hasSoftMask: image.hasSoftMask,
      ...(image.softMaskBytes === undefined ? {} : { softMaskBytes: image.softMaskBytes }),
      hasMask: image.hasMask,
      streamBytes: image.streamBytes,
      drawnWidthPt: image.drawnWidthPt,
      drawnHeightPt: image.drawnHeightPt,
      ...(effectiveDpi === undefined ? {} : { effectiveDpi }),
      ...(image.occurrence ? { occurrence: image.occurrence } : {}),
      shrinkable: !reason,
      ...(reason ? { skipReason: reason } : {}),
    };
  }).concat(extras);
  const shrinkable = images.filter((image) => image.shrinkable);
  const unused = images.filter((image) => image.skipReason === 'never drawn');
  const duplicates = await duplicateTotals(mutable, signal);
  return {
    fileSize: bytes.byteLength,
    bytesInShrinkableImages: shrinkable.reduce((total, image) => total + image.streamBytes, 0),
    photoCount: shrinkable.length,
    skippedCount: images.length - shrinkable.length,
    trailingBytes: trailingByteCount(bytes),
    unusedPhotoBytes: unused.reduce((total, image) => total + image.streamBytes, 0),
    unusedPhotoCount: unused.length,
    duplicateBytes: duplicates.bytes,
    duplicateCount: duplicates.count,
    namesIncomplete,
    signed: hasDigitalSignature(bytes),
    images,
  };
}

const analysisCache = new WeakMap<File, Promise<CompressAnalysis>>();

export function analyzeFile(file: File, signal: AbortSignal): Promise<CompressAnalysis> {
  signal.throwIfAborted();
  let cached = analysisCache.get(file);
  if (!cached) {
    cached = file.arrayBuffer().then((buffer) => analyzePdf(new Uint8Array(buffer), signal));
    analysisCache.set(file, cached);
    void cached.catch(() => { if (analysisCache.get(file) === cached) analysisCache.delete(file); });
  }
  return cached.then((analysis) => { signal.throwIfAborted(); return analysis; });
}
