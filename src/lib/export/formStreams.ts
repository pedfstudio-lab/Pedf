import {
  decodePDFRawStream,
  PDFArray,
  PDFContentStream,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from 'pdf-lib';
import { tokenizeContentStream } from './contentStream';
import type { ContentToken } from './contentStream';
import type { ContentStreamNode } from './coveredGlyphs';

const RESOURCES = PDFName.of('Resources');
const XOBJECT = PDFName.of('XObject');
const SUBTYPE = PDFName.of('Subtype');
const FORM = PDFName.of('Form');
const PAGE_RESOURCES_KEY = 'page';

interface StreamRecord {
  readonly key: string;
  readonly depth: number;
  readonly tokens: readonly ContentToken[];
  readonly originalBytes: Uint8Array;
  /** Page content streams replace themselves; forms are copied before rewriting. */
  readonly replace?: (bytes: Uint8Array) => void;
  readonly dict?: PDFDict;
  readonly name?: string;
  readonly ownerKey?: string;
  readonly ownResources?: PDFDict;
}

export interface PageStreamTree {
  readonly roots: readonly ContentStreamNode[];
  /** Tokens of any stream the walk has already resolved, page or form. */
  tokensFor(key: string): readonly ContentToken[] | null;
  /** Resolve an image XObject name in the resource scope used by this stream. */
  imageFor(streamKey: string, name: string): ImageResourceBinding | null;
  /** Write the rewritten streams back, copying every form that changes. */
  apply(
    bytesByKey: ReadonlyMap<string, Uint8Array>,
    removedImages?: readonly ImageResourceBinding[],
  ): readonly PDFRef[];
}

export interface ImageResourceBinding {
  readonly resourceKey: string;
  readonly name: string;
  readonly ref?: PDFRef;
}

function decodedStream(stream: PDFStream): Uint8Array | null {
  try {
    if (stream instanceof PDFContentStream) return stream.getUnencodedContents();
    if (stream instanceof PDFRawStream && stream.dict.get(PDFName.of('Filter'))) {
      return decodePDFRawStream(stream).decode();
    }
    return stream.getContents();
  } catch {
    return null;
  }
}

function rawStream(dictionary: PDFDict, bytes: Uint8Array): PDFRawStream {
  dictionary.delete(PDFName.of('Filter'));
  dictionary.delete(PDFName.of('DecodeParms'));
  dictionary.delete(PDFName.Length);
  return PDFRawStream.of(dictionary, bytes);
}

function xObjectsWith(
  pdf: PDFDocument,
  resources: PDFDict | undefined,
  patch: ReadonlyMap<string, PDFRef>,
  removed: ReadonlySet<string> = new Set(),
): PDFDict {
  const cloned = resources ? resources.clone(pdf.context) : pdf.context.obj({});
  const existing = cloned.lookupMaybe(XOBJECT, PDFDict);
  const xObjects = existing ? existing.clone(pdf.context) : pdf.context.obj({});
  for (const name of removed) xObjects.delete(PDFName.of(name));
  for (const [name, ref] of patch) xObjects.set(PDFName.of(name), ref);
  cloned.set(XOBJECT, xObjects);
  return cloned;
}

/**
 * Tokenize a page's own content streams plus every Form XObject it paints, so
 * covered words can be removed from forms too. Returns null when a stream
 * cannot be decoded, which keeps the caller on its cover-only fallback.
 */
export function buildPageStreamTree(pdf: PDFDocument, pageIndex: number): PageStreamTree | null {
  const page = pdf.getPage(pageIndex);
  const records = new Map<string, StreamRecord>();
  const resolved = new Map<string, ContentStreamNode | null>();
  let failed = false;

  const resourceOwner = (record: StreamRecord): {
    readonly key: string;
    readonly resources: PDFDict | undefined;
  } => {
    if (record.ownResources) return { key: record.key, resources: record.ownResources };
    const owner = records.get(record.ownerKey ?? PAGE_RESOURCES_KEY);
    if (owner?.ownResources) return { key: owner.key, resources: owner.ownResources };
    return { key: PAGE_RESOURCES_KEY, resources: page.node.Resources() ?? undefined };
  };

  const node = (record: StreamRecord): ContentStreamNode => ({
    key: record.key,
    tokens: record.tokens,
    form(name) {
      const { key: ownerKey, resources } = resourceOwner(record);
      const childKey = `${ownerKey}/${name}`;
      const cached = resolved.get(childKey);
      if (cached !== undefined) return cached;

      const stream = resources
        ?.lookupMaybe(XOBJECT, PDFDict)
        ?.lookupMaybe(PDFName.of(name), PDFStream);
      if (!stream || stream.dict.get(SUBTYPE) !== FORM) {
        resolved.set(childKey, null);
        return null;
      }
      const bytes = decodedStream(stream);
      if (!bytes) {
        failed = true;
        resolved.set(childKey, null);
        return null;
      }
      let tokens: readonly ContentToken[];
      try {
        tokens = tokenizeContentStream(bytes);
      } catch {
        failed = true;
        resolved.set(childKey, null);
        return null;
      }
      const child: StreamRecord = {
        key: childKey,
        depth: record.depth + 1,
        tokens,
        originalBytes: bytes,
        dict: stream.dict,
        name,
        ownerKey,
        ownResources: stream.dict.lookupMaybe(RESOURCES, PDFDict) ?? undefined,
      };
      records.set(childKey, child);
      const childNode = node(child);
      resolved.set(childKey, childNode);
      return childNode;
    },
  });

  const contents = page.node.Contents();
  const streams: Array<{ stream: PDFStream; replace(bytes: Uint8Array): void }> = [];
  if (contents instanceof PDFStream) {
    streams.push({
      stream: contents,
      replace(bytes) {
        const ref = pdf.context.register(rawStream(contents.dict.clone(pdf.context), bytes));
        page.node.set(PDFName.Contents, ref);
      },
    });
  } else if (contents instanceof PDFArray) {
    for (let index = 0; index < contents.size(); index += 1) {
      const stream = contents.lookupMaybe(index, PDFStream);
      if (!stream) return null;
      streams.push({
        stream,
        replace(bytes) {
          contents.set(index, pdf.context.register(rawStream(stream.dict.clone(pdf.context), bytes)));
        },
      });
    }
  }

  const roots: ContentStreamNode[] = [];
  for (const [index, binding] of streams.entries()) {
    const bytes = decodedStream(binding.stream);
    if (!bytes) return null;
    let tokens: readonly ContentToken[];
    try {
      tokens = tokenizeContentStream(bytes);
    } catch {
      return null;
    }
    const record: StreamRecord = {
      key: `page:${index}`,
      depth: 0,
      tokens,
      originalBytes: bytes,
      replace: binding.replace,
      ownerKey: PAGE_RESOURCES_KEY,
    };
    records.set(record.key, record);
    roots.push(node(record));
  }

  return {
    roots,
    tokensFor(key) {
      return records.get(key)?.tokens ?? null;
    },
    imageFor(streamKey, name) {
      const record = records.get(streamKey);
      if (!record) return null;
      const owner = resourceOwner(record);
      const xObjects = owner.resources?.lookupMaybe(XOBJECT, PDFDict);
      const key = PDFName.of(name);
      const stream = xObjects?.lookupMaybe(key, PDFStream);
      if (!stream || stream.dict.get(SUBTYPE) !== PDFName.of('Image')) return null;
      const raw = xObjects?.get(key);
      return {
        resourceKey: owner.key,
        name,
        ...(raw instanceof PDFRef ? { ref: raw } : {}),
      };
    },
    apply(bytesByKey, removedImages = []) {
      if (failed) return [];
      const removedRefs = removedImages.flatMap((binding) => binding.ref ? [binding.ref] : []);
      const removals = new Map<string, Set<string>>();
      for (const binding of removedImages) {
        const names = removals.get(binding.resourceKey) ?? new Set<string>();
        names.add(binding.name);
        removals.set(binding.resourceKey, names);
      }
      const patches = new Map<string, Map<string, PDFRef>>();
      const deepestFirst = [...records.values()].sort((left, right) => right.depth - left.depth);
      for (const record of deepestFirst) {
        const childPatch = patches.get(record.key);
        const removedNames = removals.get(record.key);
        const bytes = bytesByKey.get(record.key);
        if (!bytes && !childPatch && !removedNames) continue;
        if (record.replace) {
          if (bytes) record.replace(bytes);
          continue;
        }
        if (!record.dict || !record.name || !record.ownerKey) continue;
        const dictionary = record.dict.clone(pdf.context);
        if (childPatch || removedNames) {
          dictionary.set(
            RESOURCES,
            xObjectsWith(pdf, record.ownResources, childPatch ?? new Map(), removedNames),
          );
        }
        const ref = pdf.context.register(rawStream(dictionary, bytes ?? record.originalBytes));
        const owner = patches.get(record.ownerKey) ?? new Map<string, PDFRef>();
        owner.set(record.name, ref);
        patches.set(record.ownerKey, owner);
      }
      const pagePatch = patches.get(PAGE_RESOURCES_KEY);
      const pageRemovals = removals.get(PAGE_RESOURCES_KEY);
      if (pagePatch || pageRemovals) {
        page.node.set(
          RESOURCES,
          xObjectsWith(pdf, page.node.Resources() ?? undefined, pagePatch ?? new Map(), pageRemovals),
        );
      }
      return removedRefs;
    },
  };
}
