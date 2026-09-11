import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFParser,
  PDFRef,
  PDFStream,
  PDFWriter,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';

/**
 * Page rescue for files whose page list is gone (Task 61 Rev 1).
 *
 * Many PDFs keep their page list and catalog at the very END of the file (GOA 2026: at 99.4%), while the pages
 * themselves come early. A download that stops anywhere therefore loses the list, and neither pdf-lib nor pdf.js
 * can open the file — although most pages are still in it. Here we read every complete object with pdf-lib's
 * low-level parser (object streams included), collect the objects marked `/Type /Page`, and give them a fresh
 * page list and catalog. The result is a normal PDF the other repair tries can then check and clean.
 */

export interface RescuedFile {
  /** A complete PDF holding every page that was found, under a fresh page list. */
  bytes: Uint8Array;
  pageCount: number;
  /** 0-based positions, in the rescued file, of pages that point at parts no longer in the file. */
  incompletePages: number[];
}

const A4 = [0, 0, 595.28, 841.89] as const;
const OBJECTS_PER_TICK = 200;
const TYPE = PDFName.of('Type');
const PAGE = PDFName.of('Page');
const PARENT = PDFName.of('Parent');
const MEDIA_BOX = PDFName.of('MediaBox');
const CONTENTS = PDFName.of('Contents');
const RESOURCES = PDFName.of('Resources');

function lastIndexOfAscii(bytes: Uint8Array, text: string): number {
  const codes = Array.from(text, (character) => character.charCodeAt(0));
  outer: for (let index = bytes.length - codes.length; index >= 0; index -= 1) {
    for (let offset = 0; offset < codes.length; offset += 1) {
      if (bytes[index + offset] !== codes[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

/** Cut after the last complete object, so a half-written object at a cut-off end is dropped, not misread. */
function completeObjectsOnly(bytes: Uint8Array): Uint8Array | undefined {
  const end = lastIndexOfAscii(bytes, 'endobj');
  return end < 0 ? undefined : bytes.subarray(0, end + 'endobj'.length);
}

function resolve(context: PDFContext, object: PDFObject | undefined): PDFObject | undefined {
  return object instanceof PDFRef ? context.lookup(object) : object;
}

/** A file that still has its catalog and page list is not a lost-page-list case; leave it to the other tries. */
function hasWorkingPageList(context: PDFContext): boolean {
  const catalog = resolve(context, context.trailerInfo.Root);
  return catalog instanceof PDFDict && resolve(context, catalog.get(PDFName.of('Pages'))) instanceof PDFDict;
}

/** Does anything the page draws with — its content or its resources — point at an object that is gone? */
function pointsAtMissingParts(context: PDFContext, page: PDFDict): boolean {
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  for (const key of [CONTENTS, RESOURCES]) {
    const value = page.get(key);
    if (value) stack.push(value);
  }
  let budget = 20_000;
  while (stack.length && budget > 0) {
    budget -= 1;
    const item = stack.pop()!;
    if (item instanceof PDFRef) {
      const tag = item.toString();
      if (seen.has(tag)) continue;
      seen.add(tag);
      const target = context.lookup(item);
      if (target === undefined) return true;
      stack.push(target);
    } else if (item instanceof PDFDict) {
      for (const [key, value] of item.entries()) if (key !== PARENT) stack.push(value);
    } else if (item instanceof PDFArray) {
      for (let index = 0; index < item.size(); index += 1) stack.push(item.get(index));
    } else if (item instanceof PDFStream) {
      stack.push(item.dict);
    }
  }
  return false;
}

/** Rebuild a page list for pages left without one. `undefined` when this is not such a file or nothing is found. */
export async function rescuePageList(bytes: Uint8Array): Promise<RescuedFile | undefined> {
  const complete = completeObjectsOnly(bytes);
  if (!complete) return undefined;

  let context: PDFContext;
  try {
    context = await PDFParser.forBytesWithOptions(complete, OBJECTS_PER_TICK, false).parseDocument();
  } catch {
    return undefined;
  }
  if (hasWorkingPageList(context)) return undefined;

  // Writers number pages in reading order, so object-number order is the best guess for page order.
  const pages = context.enumerateIndirectObjects()
    .filter((entry): entry is [PDFRef, PDFDict] => entry[1] instanceof PDFDict && entry[1].get(TYPE) === PAGE)
    .sort(([left], [right]) => left.objectNumber - right.objectNumber || left.generationNumber - right.generationNumber);
  if (!pages.length) return undefined;

  // Pages often inherited their size from the lost list: use the most common size among pages that have one.
  const boxCounts = new Map<string, { box: PDFObject; count: number }>();
  for (const [, page] of pages) {
    const box = page.get(MEDIA_BOX);
    if (!box) continue;
    const entry = boxCounts.get(box.toString()) ?? { box, count: 0 };
    entry.count += 1;
    boxCounts.set(box.toString(), entry);
  }
  const fallbackBox = [...boxCounts.values()].sort((left, right) => right.count - left.count)[0]?.box
    ?? context.obj([...A4]);

  const pagesRef = context.nextRef();
  const incompletePages: number[] = [];
  pages.forEach(([, page], index) => {
    page.set(PARENT, pagesRef);
    if (!page.has(MEDIA_BOX)) page.set(MEDIA_BOX, fallbackBox);
    if (pointsAtMissingParts(context, page)) incompletePages.push(index);
  });
  context.assign(pagesRef, context.obj({ Type: 'Pages', Kids: pages.map(([ref]) => ref), Count: pages.length }));
  context.trailerInfo.Root = context.register(context.obj({ Type: 'Catalog', Pages: pagesRef }));
  context.trailerInfo.Encrypt = undefined;

  try {
    const rebuilt = await PDFWriter.forContext(context, OBJECTS_PER_TICK).serializeToBuffer();
    return { bytes: rebuilt, pageCount: pages.length, incompletePages };
  } catch {
    return undefined;
  }
}
