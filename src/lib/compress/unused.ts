import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import { xObjectNamesInContent } from '@/lib/images/extractImage';
import type { CompressAnalysis, ImageReference } from './analyze';

interface Binding { readonly dictionary: PDFDict; readonly name: PDFName }

function keyOf(ref: PDFRef | ImageReference): string {
  return `${ref.objectNumber}:${ref.generationNumber}`;
}

function resolve(document: PDFDocument, object: PDFObject | undefined): PDFObject | undefined {
  return object instanceof PDFRef ? document.context.lookup(object) : object;
}

function contentStreams(contents: PDFObject | undefined, document: PDFDocument): PDFStream[] {
  const resolved = resolve(document, contents);
  if (resolved instanceof PDFStream) return [resolved];
  if (!(resolved instanceof PDFArray)) return [];
  const streams: PDFStream[] = [];
  for (let index = 0; index < resolved.size(); index++) {
    const stream = resolved.lookupMaybe(index, PDFStream);
    if (stream) streams.push(stream);
  }
  return streams;
}

function annotationProtectedRefs(document: PDFDocument, candidates: ReadonlySet<string>): Set<string> {
  const protectedRefs = new Set<string>();
  const visitedRefs = new Set<string>();
  const visitedObjects = new Set<PDFObject>();
  const visit = (raw: PDFObject | undefined) => {
    if (!raw) return;
    if (raw instanceof PDFRef) {
      const key = keyOf(raw);
      if (candidates.has(key)) protectedRefs.add(key);
      if (visitedRefs.has(key)) return;
      visitedRefs.add(key);
    }
    const object = resolve(document, raw);
    if (!object || visitedObjects.has(object)) return;
    visitedObjects.add(object);
    if (object instanceof PDFArray) {
      for (let index = 0; index < object.size(); index++) visit(object.get(index));
    } else if (object instanceof PDFDict || object instanceof PDFStream) {
      const dictionary = object instanceof PDFStream ? object.dict : object;
      for (const name of dictionary.keys()) visit(dictionary.get(name));
    }
  };
  for (const page of document.getPages()) {
    const annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annotations) continue;
    for (let index = 0; index < annotations.size(); index++) {
      const annotation = annotations.lookupMaybe(index, PDFDict);
      visit(annotation?.get(PDFName.of('AP')));
    }
  }
  return protectedRefs;
}

function maskProtectedRefs(document: PDFDocument, candidates: ReadonlySet<string>): Set<string> {
  const protectedRefs = new Set<string>();
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream) || object.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() !== 'Image') continue;
    for (const name of ['SMask', 'Mask']) {
      const raw = object.dict.get(PDFName.of(name));
      if (raw instanceof PDFRef && candidates.has(keyOf(raw))) protectedRefs.add(keyOf(raw));
    }
  }
  return protectedRefs;
}

function auditResources(
  document: PDFDocument,
  candidates: ReadonlySet<string>,
): { readonly complete: boolean; readonly used: Set<string>; readonly bindings: Map<string, Binding[]> } {
  const used = new Set<string>();
  const bindings = new Map<string, Binding[]>();
  const visited = new WeakMap<PDFStream, Set<PDFDict>>();
  let complete = true;

  const walk = (streams: readonly PDFStream[], resources: PDFDict | undefined) => {
    if (!resources) return;
    const xObjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xObjects) return;
    for (const stream of streams) {
      const names = xObjectNamesInContent(stream);
      if (!names) { complete = false; continue; }
      for (const name of names) {
        const raw = xObjects.get(PDFName.of(name));
        if (raw instanceof PDFRef && candidates.has(keyOf(raw))) used.add(keyOf(raw));
      }
    }
    for (const name of xObjects.keys()) {
      const raw = xObjects.get(name);
      const object = resolve(document, raw);
      if (!(object instanceof PDFStream)) continue;
      const subtype = object.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
      if (subtype === 'Image' && raw instanceof PDFRef && candidates.has(keyOf(raw))) {
        const key = keyOf(raw);
        const entries = bindings.get(key) ?? [];
        entries.push({ dictionary: xObjects, name });
        bindings.set(key, entries);
      }
      if (subtype !== 'Form') continue;
      const formResources = object.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources;
      let resourceVisits = visited.get(object);
      if (!resourceVisits) { resourceVisits = new Set(); visited.set(object, resourceVisits); }
      if (resourceVisits.has(formResources)) continue;
      resourceVisits.add(formResources);
      walk([object], formResources);
    }
  };

  for (const page of document.getPages()) {
    walk(contentStreams(page.node.Contents(), document), page.node.Resources());
  }
  return { complete, used, bindings };
}

function externallyReferencedCandidates(
  document: PDFDocument,
  candidates: ReadonlySet<string>,
  bindings: ReadonlyMap<string, readonly Binding[]>,
): Set<string> {
  const ignoredBindings = new Map<PDFDict, Set<string>>();
  for (const entries of bindings.values()) {
    for (const binding of entries) {
      const ignored = ignoredBindings.get(binding.dictionary) ?? new Set<string>();
      ignored.add(binding.name.asString());
      ignoredBindings.set(binding.dictionary, ignored);
    }
  }
  const referenced = new Set<string>();
  const visited = new Set<PDFObject>();
  const visit = (object: PDFObject | undefined) => {
    if (!object) return;
    if (object instanceof PDFRef) {
      const key = keyOf(object);
      if (candidates.has(key)) referenced.add(key);
      return;
    }
    if (visited.has(object)) return;
    visited.add(object);
    if (object instanceof PDFArray) {
      for (let index = 0; index < object.size(); index++) visit(object.get(index));
      return;
    }
    const dictionary = object instanceof PDFStream ? object.dict : object instanceof PDFDict ? object : undefined;
    if (!dictionary) return;
    const ignored = ignoredBindings.get(dictionary);
    for (const name of dictionary.keys()) {
      if (ignored?.has(name.asString())) continue;
      visit(dictionary.get(name));
    }
  };
  for (const [, object] of document.context.enumerateIndirectObjects()) visit(object);
  return referenced;
}

/** Remove only images that both pdf.js and an independent content-name audit agree are unused. */
export function removeUnusedImages(
  document: PDFDocument,
  analysis: CompressAnalysis,
): { removed: number; bytes: number } {
  if (analysis.namesIncomplete) return { removed: 0, bytes: 0 };
  const candidates = new Map(analysis.images.flatMap((image) => image.skipReason === 'never drawn' && image.ref
    ? [[keyOf(image.ref), image] as const] : []));
  if (!candidates.size) return { removed: 0, bytes: 0 };
  const candidateKeys = new Set(candidates.keys());
  const audit = auditResources(document, candidateKeys);
  if (!audit.complete) return { removed: 0, bytes: 0 };
  const protectedRefs = annotationProtectedRefs(document, candidateKeys);
  for (const key of maskProtectedRefs(document, candidateKeys)) protectedRefs.add(key);
  for (const key of externallyReferencedCandidates(document, candidateKeys, audit.bindings)) protectedRefs.add(key);
  let removed = 0;
  let bytes = 0;
  for (const [key, image] of candidates) {
    const bindings = audit.bindings.get(key);
    if (!bindings?.length || audit.used.has(key) || protectedRefs.has(key) || !image.ref) continue;
    for (const binding of bindings) binding.dictionary.delete(binding.name);
    document.context.delete(PDFRef.of(image.ref.objectNumber, image.ref.generationNumber));
    removed += 1;
    bytes += image.streamBytes;
  }
  return { removed, bytes };
}
