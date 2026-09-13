import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import type { ImageReference } from './analyze';
import { MIN_PHOTO_SAVING } from './recode';

const PRESERVED_KEYS = ['OC', 'Metadata'] as const;
const HASH_KEYS = ['Width', 'Height', 'Filter', 'ColorSpace', 'BitsPerComponent', 'Decode', 'DecodeParms', 'ImageMask', 'SMask', 'Mask'] as const;

export function pdfRef(reference: ImageReference): PDFRef {
  return PDFRef.of(reference.objectNumber, reference.generationNumber);
}

function referenceCount(object: PDFObject, target: PDFRef, visited: Set<PDFObject>): number {
  if (object instanceof PDFRef) return object.toString() === target.toString() ? 1 : 0;
  if (visited.has(object)) return 0;
  if (object instanceof PDFStream) return referenceCount(object.dict, target, visited);
  if (object instanceof PDFDict) {
    visited.add(object);
    return object.keys().reduce((count, key) => {
      const value = object.get(key);
      return count + (value ? referenceCount(value, target, visited) : 0);
    }, 0);
  }
  if (object instanceof PDFArray) {
    visited.add(object);
    let count = 0;
    for (let index = 0; index < object.size(); index++) {
      const value = object.get(index);
      if (value) count += referenceCount(value, target, visited);
    }
    return count;
  }
  return 0;
}

function wholeFileReferenceCount(document: PDFDocument, target: PDFRef): number {
  return document.context.enumerateIndirectObjects().reduce((count, [, object]) =>
    count + referenceCount(object, target, new Set()), 0);
}

function pngUpPredictor(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    output[row] = 2;
    for (let x = 0; x < width; x++) {
      const source = y * width + x;
      output[row + x + 1] = (pixels[source]! - (y > 0 ? pixels[source - width]! : 0)) & 0xff;
    }
  }
  return output;
}

export function replacementClearsCombinedGuard(
  oldPhotoBytes: number,
  oldMaskBytes: number,
  newPhotoBytes: number,
  newMaskBytes: number,
): boolean {
  const oldPairBytes = oldPhotoBytes + oldMaskBytes;
  const newPairBytes = newPhotoBytes + newMaskBytes;
  return oldPairBytes - newPairBytes >= MIN_PHOTO_SAVING && newPairBytes <= oldPairBytes * 0.85;
}

/** Build the same encoded 8-bit mask stream used by replacement, without assigning it to the PDF. */
export function resizedSoftMaskStream(
  document: PDFDocument,
  softMask: Uint8Array,
  target: { width: number; height: number },
  original?: PDFRawStream,
): PDFRawStream {
  if (softMask.length !== target.width * target.height) {
    throw new Error('The resized PDF image mask has the wrong dimensions.');
  }
  const resized = document.context.flateStream(pngUpPredictor(softMask, target.width, target.height), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: target.width,
    Height: target.height,
    ColorSpace: 'DeviceGray',
    BitsPerComponent: 8,
    DecodeParms: {
      Predictor: 15,
      Colors: 1,
      BitsPerComponent: 8,
      Columns: target.width,
    },
  });
  for (const key of ['Decode', 'Matte', 'Interpolate'] as const) {
    const value = original?.dict.get(PDFName.of(key));
    if (value) resized.dict.set(PDFName.of(key), value);
  }
  return resized;
}

/** Replace an image at its existing reference, so every page and form keeps using the same object. */
export function replaceImage(
  document: PDFDocument,
  reference: ImageReference,
  jpeg: Uint8Array,
  target: { width: number; height: number },
  softMask?: Uint8Array,
): boolean {
  const ref = pdfRef(reference);
  const old = document.context.lookup(ref);
  if (!(old instanceof PDFRawStream)) throw new Error('The PDF image could not be found.');
  const oldWidth = old.dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber();
  const oldHeight = old.dict.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber();
  const oldMask = old.dict.get(PDFName.of('SMask'));
  const resized = oldWidth !== target.width || oldHeight !== target.height;
  const dict = document.context.obj({
    Type: 'XObject',
    Subtype: 'Image',
    Width: target.width,
    Height: target.height,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
    Filter: 'DCTDecode',
  }) as PDFDict;
  for (const key of PRESERVED_KEYS) {
    const value = old.dict.get(PDFName.of(key));
    if (value) dict.set(PDFName.of(key), value);
  }
  if (oldMask) {
    let replacementMask: PDFObject = oldMask;
    const resolvedMask = oldMask instanceof PDFRef ? document.context.lookup(oldMask) : oldMask;
    if (!(resolvedMask instanceof PDFRawStream)) throw new Error('The PDF image mask could not be found.');
    let chosenMaskBytes = resolvedMask.contents.length;
    let resizedMask: PDFRawStream | undefined;
    if (resized && softMask) {
      const candidate = resizedSoftMaskStream(document, softMask, target, resolvedMask);
      if (candidate.contents.length < resolvedMask.contents.length) {
        resizedMask = candidate;
        chosenMaskBytes = candidate.contents.length;
      }
    }
    if (!replacementClearsCombinedGuard(
      old.contents.length, resolvedMask.contents.length, jpeg.length, chosenMaskBytes,
    )) return false;
    if (resizedMask) {
      if (oldMask instanceof PDFRef && wholeFileReferenceCount(document, oldMask) <= 1) {
        document.context.assign(oldMask, resizedMask);
      } else replacementMask = document.context.register(resizedMask);
    }
    dict.set(PDFName.of('SMask'), replacementMask);
  }
  document.context.assign(ref, PDFRawStream.of(dict, jpeg));
  return true;
}

interface Binding { readonly dictionary: PDFDict; readonly name: PDFName; readonly ref: PDFRef; readonly stream: PDFRawStream }

function resolve(document: PDFDocument, object: PDFObject | undefined): PDFObject | undefined {
  return object instanceof PDFRef ? document.context.lookup(object) : object;
}

function imageBindings(document: PDFDocument): Binding[] {
  const bindings: Binding[] = [];
  const visitedRefForms = new Set<string>();
  const visitedDirectForms = new Set<PDFStream>();
  const walk = (resources: PDFDict | undefined) => {
    const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xObjects) return;
    for (const name of xObjects.keys()) {
      const raw = xObjects.get(name);
      const object = resolve(document, raw);
      if (!(object instanceof PDFStream)) continue;
      const subtype = object.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
      if (subtype === 'Image' && object instanceof PDFRawStream && raw instanceof PDFRef) {
        bindings.push({ dictionary: xObjects, name, ref: raw, stream: object });
      }
      if (subtype !== 'Form') continue;
      if (raw instanceof PDFRef) {
        const key = raw.toString();
        if (visitedRefForms.has(key)) continue;
        visitedRefForms.add(key);
      } else {
        if (visitedDirectForms.has(object)) continue;
        visitedDirectForms.add(object);
      }
      walk(object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources);
    }
  };
  for (const page of document.getPages()) walk(page.node.Resources());
  return bindings;
}

export async function imageDeduplicationHash(stream: PDFRawStream): Promise<string> {
  const essentials = HASH_KEYS.map((key) => `${key}=${stream.dict.get(PDFName.of(key))?.toString() ?? ''}`).join('|');
  const header = new TextEncoder().encode(`${essentials}|`);
  const bytes = new Uint8Array(header.length + stream.contents.length);
  bytes.set(header);
  bytes.set(stream.contents, header.length);
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

/** Repoint identical XObject entries to one canonical ref and remove the duplicate objects. */
export async function deduplicateImages(document: PDFDocument, signal?: AbortSignal): Promise<number> {
  const bindings = imageBindings(document);
  const byRef = new Map<string, Binding>();
  for (const binding of bindings) if (!byRef.has(binding.ref.toString())) byRef.set(binding.ref.toString(), binding);
  const canonicalByHash = new Map<string, PDFRef>();
  const replacement = new Map<string, PDFRef>();
  for (const binding of byRef.values()) {
    signal?.throwIfAborted();
    const hash = await imageDeduplicationHash(binding.stream);
    const canonical = canonicalByHash.get(hash);
    if (canonical) replacement.set(binding.ref.toString(), canonical);
    else canonicalByHash.set(hash, binding.ref);
  }
  for (const binding of bindings) {
    const canonical = replacement.get(binding.ref.toString());
    if (canonical) binding.dictionary.set(binding.name, canonical);
  }
  for (const duplicate of byRef.values()) {
    if (replacement.has(duplicate.ref.toString())) document.context.delete(duplicate.ref);
  }
  return replacement.size;
}
