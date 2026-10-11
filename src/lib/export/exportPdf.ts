import { PDFDocument } from 'pdf-lib';
import { groupBy } from '@/lib/util/groupBy';
import { invariant } from '@/lib/util/assert';
import { isIdentityPagePlan } from '@/state/pagePlan';
import { pdfjs } from '@/lib/pdf/worker';
import { makePageContext } from './context';
import { HANDLERS } from './registry';
import type { EditHandler } from './registry';
import type { CoverEdit, EditDocument, ExportRedactionResult } from './types';
import {
  rewriteTextShowOperator,
  serializeContentStream,
  textShowOperators,
  tokenizeContentStream,
} from './contentStream';
import type { ContentToken } from './contentStream';
import { planCoveredGlyphRemoval } from './coveredGlyphs';
import type { CoveredGlyphRewrite } from './coveredGlyphs';
import { buildPageStreamTree } from './formStreams';
import {
  deleteUnreachableImageObjects,
  outsideCoverImageWarning,
  planCoveredImageRemoval,
  rewriteImagePaintOperators,
} from './coveredImages';
import type { CoveredImageRewrite } from './coveredImages';
import type { PDFRef } from 'pdf-lib';
import { planCoveredShapeRemoval, rewriteShapePaintOperators, sourceShapeFormUses } from './coveredShapes';
import type { CoveredShapeRewrite } from './coveredShapes';
import { shapeMarkerRegionsFromOperatorList } from '@/lib/pdf/shapeMarkers';
import { isArrowBullet } from '@/lib/pdf/symbolBullets';
import type { PdfRect } from './types';

const REMOVE_COVERED_TEXT = true;
const REMOVE_COVERED_IMAGES = true;

export interface PageWritingOptions {
  readonly removeCoveredText?: boolean;
  readonly removeCoveredImages?: boolean;
  readonly removeCoveredShapes?: boolean;
  /** Preview can reuse the already-loaded pristine reader; it never owns/destroys it. */
  readonly reader?: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;
  readonly omitTextIds?: ReadonlySet<string>;
}

function rewriteCombinedStream(
  original: readonly ContentToken[],
  imageRewrites: readonly CoveredImageRewrite[],
  textRewrites: readonly CoveredGlyphRewrite[],
  shapeRewrites: readonly CoveredShapeRewrite[] = [],
): Uint8Array | null {
  const shapeBytes = shapeRewrites.length ? rewriteShapePaintOperators(original, shapeRewrites) : serializeContentStream(original);
  if (!shapeBytes) return null;
  const afterShapes = tokenizeContentStream(shapeBytes);
  const imageBytes = imageRewrites.length > 0
    ? rewriteImagePaintOperators(afterShapes, imageRewrites)
    : shapeBytes;
  if (!imageBytes) return null;
  const afterImages = tokenizeContentStream(imageBytes);
  return textRewrites.length > 0 ? rewriteStream(afterImages, textRewrites) : imageBytes;
}

export interface ExportResult {
  readonly bytes: Uint8Array;
  readonly warnings: string[];
  readonly redaction: ExportRedactionResult;
}

function rewriteStream(
  original: readonly ContentToken[],
  rewrites: readonly CoveredGlyphRewrite[],
): Uint8Array | null {
  try {
    const expectedCount = textShowOperators(original).length;
    let tokens = [...original];
    for (const rewrite of [...rewrites].sort((left, right) => right.operatorOrdinal - left.operatorOrdinal)) {
      const target = textShowOperators(tokens)[rewrite.operatorOrdinal];
      if (!target) return null;
      tokens = rewriteTextShowOperator(
        tokens,
        target,
        rewrite.glyphByteRanges,
        rewrite.removedRanges,
        rewrite.advanceThousandths,
      );
    }
    const bytes = serializeContentStream(tokens);
    const reparsed = tokenizeContentStream(bytes);
    if (textShowOperators(reparsed).length !== expectedCount) return null;
    return bytes;
  } catch {
    return null;
  }
}

function sourcePageIndex(doc: EditDocument, pageIndex: number): number | null {
  const entry = doc.plan?.[pageIndex];
  if (!entry) return pageIndex;
  return entry.kind === 'source' ? entry.sourceIndex : null;
}

/**
 * Read the original bytes for the redaction pass. The browser uses the app's
 * worker-backed PDF.js; Node (tests, scripts) has no worker URL, so it loads
 * the legacy build, which runs on the main thread. The specifier is hidden from
 * the bundler so the legacy build never reaches the browser bundle.
 */
async function readForRedaction(
  bytes: Uint8Array,
): Promise<Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>> {
  const options = { data: bytes.slice(), fontExtraProperties: true };
  if (typeof window === 'undefined') {
    const specifier = 'pdfjs-dist/legacy/build/pdf.mjs';
    const legacy = await import(/* @vite-ignore */ specifier) as typeof pdfjs;
    return legacy.getDocument(options).promise;
  }
  return pdfjs.getDocument(options).promise;
}

/**
 * Whether a cover takes part in text removal.
 *
 * A cover with no pictures always does - including an older cover that names no
 * replacements and removes whatever text lies under it. A cover that carries
 * pictures takes part only when it also names the text it replaces: that is a
 * bullet list whose markers are images, and without this its old words stayed in
 * the exported file, hidden under the patch.
 *
 * A picture-only cover - a deleted or moved photo - must never be let in. It
 * names no replacements, so it would remove every glyph beneath the picture.
 */
function removesText(edit: EditDocument['edits'][number]): edit is CoverEdit {
  return edit.kind === 'cover'
    && ((edit.replacesImages === undefined && edit.replacesShapes === undefined) || (edit.replaces?.length ?? 0) > 0);
}

/**
 * A bullet list edited before Task 76 never recorded its drawn dots, so they are
 * still on the page. Its cover is followed by the redrawn dot (or the empty
 * anchor of an emptied list).
 */
function isOldListCover(cover: CoverEdit, pageEdits: EditDocument['edits']): boolean {
  if (cover.replacesShapes !== undefined || !cover.replaces?.length) return false;
  return pageEdits.some((edit) => edit.kind === 'text' && edit.z === cover.z + 1
    && (edit.text === '•' || edit.text === '' || isArrowBullet(edit.text)));
}

function insideRect(inner: PdfRect, outer: PdfRect, slack = 0.5): boolean {
  return inner.x >= outer.x - slack && inner.y >= outer.y - slack
    && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack;
}

async function removeCoveredContent(
  pdf: PDFDocument,
  doc: EditDocument,
  editsByPage: Map<number, EditDocument['edits']>,
  warnings: string[],
  satisfiedTextCovers: Set<CoverEdit>,
  textEnabled: boolean,
  imagesEnabled: boolean,
  sharedReader?: PageWritingOptions['reader'],
  shapesEnabled = true,
): Promise<ExportRedactionResult> {
  const textPages = [...editsByPage.entries()].flatMap(([pageIndex, edits]) => (
    edits.some(removesText) ? [pageIndex] : []
  ));
  const imagePages = [...editsByPage.entries()].flatMap(([pageIndex, edits]) => (
    edits.some((edit) => edit.kind === 'cover' && (edit.replacesImages?.length ?? 0) > 0)
      ? [pageIndex]
      : []
  ));
  const eligibleTextPages = textEnabled ? textPages : [];
  const eligibleImagePages = imagesEnabled ? imagePages : [];
  const shapePages = [...editsByPage.entries()].filter(([, edits]) => edits.some(edit => edit.kind === 'cover' && (edit.replacesShapes?.length ?? 0) > 0)).map(([index]) => index);
  const eligibleShapePages = shapesEnabled ? shapePages : [];
  const eligiblePages = [...new Set([...eligibleTextPages, ...eligibleImagePages, ...eligibleShapePages])];
  const empty = {
    removedItems: 0,
    skippedPages: 0,
    removedImages: 0,
    unmatchedImages: 0,
    outsideCoverImages: 0,
    imageSkippedPages: 0,
    ...(shapePages.length ? { removedShapes: 0, unmatchedShapes: 0 } : {}),
  };
  if (eligiblePages.length === 0) return empty;
  if (pdf.context.trailerInfo.Encrypt) {
    for (const pageIndex of eligibleTextPages) {
      warnings.push(`Old text on page ${pageIndex + 1} could not be removed; it stays hidden under the cover.`);
    }
    for (const pageIndex of eligibleImagePages) {
      warnings.push(`Old images on page ${pageIndex + 1} could not be removed; they stay hidden under the cover.`);
    }
    return {
      ...empty,
      skippedPages: eligibleTextPages.length,
      imageSkippedPages: eligibleImagePages.length,
    };
  }

  let skippedPages = 0;
  let imageSkippedPages = 0;

  let reader: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | undefined;
  let removedItems = 0;
  let removedImages = 0;
  let unmatchedImages = 0;
  let outsideCoverImages = 0;
  let removedShapes = 0, unmatchedShapes = 0;
  const removedImageRefs: PDFRef[] = [];
  try {
    reader = sharedReader ?? await readForRedaction(doc.originalBytes);
  } catch {
    for (const pageIndex of eligibleTextPages) {
      warnings.push(`Old text on page ${pageIndex + 1} could not be removed; it stays hidden under the cover.`);
    }
    for (const pageIndex of eligibleImagePages) {
      warnings.push(`Old images on page ${pageIndex + 1} could not be removed; they stay hidden under the cover.`);
    }
    return {
      ...empty,
      skippedPages: eligibleTextPages.length,
      imageSkippedPages: eligibleImagePages.length,
    };
  }

  try {
    for (const pageIndex of eligiblePages) {
      const removeText = eligibleTextPages.includes(pageIndex);
      const removeImages = eligibleImagePages.includes(pageIndex);
      const removeShapes = eligibleShapePages.includes(pageIndex);
      let textReason: string | undefined;
      let imageReason: string | undefined;
      let shapeReason: string | undefined;
      try {
        const tree = buildPageStreamTree(pdf, pageIndex);
        const originalPageIndex = sourcePageIndex(doc, pageIndex);
        if (!tree) {
          if (removeText) textReason = 'the content streams could not be decoded';
          if (removeImages) imageReason = 'the content streams could not be decoded';
          if (removeShapes) shapeReason = 'the content streams could not be decoded';
        } else if (originalPageIndex === null || originalPageIndex < 0 || originalPageIndex >= reader.numPages) {
          if (removeText) textReason = 'the page has no original text source';
          if (removeImages) imageReason = 'the page has no original image source';
          if (removeShapes) shapeReason = 'the page has no original shape source';
        } else {
          const sourcePage = await reader.getPage(originalPageIndex + 1);
          // 0 = AnnotationMode.DISABLE: form-field appearances are separate objects.
          const operatorList = await sourcePage.getOperatorList({ annotationMode: 0 });
          const viewport = sourcePage.getViewport({ scale: 1, rotation: 0 });
          const pageEdits = editsByPage.get(pageIndex) ?? [];
          const textCoverEdits = pageEdits.filter(removesText);
          const shapeCoverEdits = pageEdits.filter((edit): edit is CoverEdit => edit.kind === 'cover');
          const textCovers = textCoverEdits.map((edit) => ({
            rect: edit.rect,
            replaces: edit.replaces,
          }));
          const imageCovers = pageEdits.flatMap((edit) => (
            edit.kind === 'cover' && edit.replacesImages
              ? [{ rect: edit.rect, replacesImages: edit.replacesImages }]
              : []
          ));
          const textPlan = removeText
            ? planCoveredGlyphRemoval(
                (await sourcePage.getTextContent()).items,
                operatorList,
                viewport,
                tree.roots,
                textCovers,
              )
            : undefined;
          const imagePlan = removeImages
            ? planCoveredImageRemoval(operatorList, viewport, pageIndex, tree, imageCovers)
            : undefined;
          let shapePlan: ReturnType<typeof planCoveredShapeRemoval> | undefined;
          if (removeShapes) {
            try {
              const uses = await sourceShapeFormUses(doc.originalBytes);
              shapePlan = planCoveredShapeRemoval(pdf, pageIndex, shapeCoverEdits, uses[originalPageIndex] ?? new Map(), tree);
              // Do not copy/rewrite a reused marker Form just to remove its words
              // or images. Keep the entire shared drawing on the patch fallback.
              const protectedStreams = new Set(shapePlan.protectedStreams);
              if (textPlan?.rewrites.some(rewrite => protectedStreams.has(rewrite.streamKey))) textReason = 'a marker Form is drawn more than once in the source document';
              if (imagePlan?.rewrites.some(rewrite => protectedStreams.has(rewrite.streamKey))) imageReason = 'a marker Form is drawn more than once in the source document';
              unmatchedShapes += shapePlan.unmatchedShapes;
              if (shapePlan.unmatchedShapes) warnings.push(`A drawn bullet on page ${pageIndex + 1} could not be removed safely; it stays hidden under the cover.`);
            } catch (error) {
              // Only the drawn dots fall back to the patch; their words and
              // pictures are still removed as before Task 76.
              shapeReason = error instanceof Error ? error.message : 'the paths could not be mapped safely';
            }
          }
          if (imagePlan) {
            unmatchedImages += imagePlan.unmatchedImages;
            outsideCoverImages += imagePlan.outsideCoverImages;
            for (let index = 0; index < imagePlan.unmatchedImages; index += 1) {
              warnings.push(
                `A deleted picture on page ${pageIndex + 1} could not be found in the file; `
                + 'it is still hidden under the cover but was not removed.',
              );
            }
            for (let index = 0; index < imagePlan.outsideCoverImages; index += 1) {
              warnings.push(outsideCoverImageWarning(pageIndex));
            }
          }
          if (textPlan?.skipped) textReason = textPlan.reason ?? 'the page could not be mapped safely';
          if (imagePlan?.skipped) imageReason = imagePlan.reason ?? 'the page could not be mapped safely';

          const textRewrites = textReason ? [] : (textPlan?.rewrites ?? []);
          const imageRewrites = imageReason ? [] : (imagePlan?.rewrites ?? []);
          const rewriteStreams = (shapeRewrites: readonly CoveredShapeRewrite[]) => {
            const rewritten = new Map<string, Uint8Array>();
            const streamKeys = new Set([
              ...textRewrites.map((rewrite) => rewrite.streamKey),
              ...imageRewrites.map((rewrite) => rewrite.streamKey),
              ...shapeRewrites.map((rewrite) => rewrite.streamKey),
            ]);
            for (const key of streamKeys) {
              const tokens = tree.tokensFor(key);
              const bytes = tokens ? rewriteCombinedStream(
                tokens,
                imageRewrites.filter((rewrite) => rewrite.streamKey === key),
                textRewrites.filter((rewrite) => rewrite.streamKey === key),
                shapeRewrites.filter((rewrite) => rewrite.streamKey === key),
              ) : null;
              if (!bytes) return { failedKey: key };
              rewritten.set(key, bytes);
            }
            return { rewritten };
          };
          let attempt = rewriteStreams(shapeReason ? [] : (shapePlan?.rewrites ?? []));
          if (attempt.failedKey && !shapeReason && shapePlan?.rewrites.some((rewrite) => rewrite.streamKey === attempt.failedKey)) {
            // The dots' stream failed its guard: keep the dots on the patch and
            // still remove the words and pictures, rather than give up on all three.
            shapeReason = 'the rewritten stream failed its round-trip guard';
            attempt = rewriteStreams([]);
          }
          if (attempt.failedKey) {
            if (textRewrites.some((rewrite) => rewrite.streamKey === attempt.failedKey)) {
              textReason = 'the rewritten stream failed its round-trip guard';
            }
            if (imageRewrites.some((rewrite) => rewrite.streamKey === attempt.failedKey)) {
              imageReason = 'the rewritten stream failed its round-trip guard';
            }
          }
          const rewritten = attempt.rewritten ?? new Map<string, Uint8Array>();
          // An older saved list over drawn dots keeps its patch: without it the
          // old dots would show next to the redrawn ones (double dots).
          const oldDots = pageEdits.some((edit) => edit.kind === 'cover' && isOldListCover(edit, pageEdits))
            ? shapeMarkerRegionsFromOperatorList(operatorList, viewport, originalPageIndex).map((region) => region.rect)
            : [];
          const keepsOldDots = (cover: CoverEdit) => isOldListCover(cover, pageEdits)
            && oldDots.some((rect) => insideRect(rect, cover.rect));
          if (!attempt.failedKey && !textReason && !imageReason) {
            removedImageRefs.push(...tree.apply(rewritten, imagePlan?.removedResources));
            removedItems += textPlan?.removedItems ?? 0;
            removedShapes += shapeReason ? 0 : shapePlan?.removedShapes ?? 0;
            // A cover that also replaces pictures - a list whose markers are images -
            // leaves no hole only when every picture named on this page was found and
            // taken out. If one was not, its patch stays.
            const picturesGone = imagePlan !== undefined
              && imagePlan.unmatchedImages === 0
              && imagePlan.outsideCoverImages === 0;
            textPlan?.satisfied.forEach((satisfied, index) => {
              const cover = textCoverEdits[index];
              const shapesGone = !cover?.replacesShapes?.length
                || (!shapeReason && shapePlan?.satisfied[shapeCoverEdits.indexOf(cover)] === true);
              if (satisfied && cover && (cover.replacesImages === undefined || picturesGone) && shapesGone && !keepsOldDots(cover)) {
                satisfiedTextCovers.add(cover);
              }
            });
            shapeCoverEdits.forEach((cover,index) => {
              if (!shapeReason && !cover.replaces?.length && !cover.replacesImages?.length && cover.replacesShapes?.length && shapePlan?.satisfied[index]) satisfiedTextCovers.add(cover);
            });
            removedImages += imagePlan?.removedImages ?? 0;
          } else if (!textReason && textPlan) {
            const textOnly = new Map<string, Uint8Array>();
            for (const key of new Set(textPlan.rewrites.map((rewrite) => rewrite.streamKey))) {
              const tokens = tree.tokensFor(key);
              const bytes = tokens
                ? rewriteStream(tokens, textPlan.rewrites.filter((rewrite) => rewrite.streamKey === key))
                : null;
              if (!bytes) {
                textReason = 'the rewritten stream failed its round-trip guard';
                break;
              }
              textOnly.set(key, bytes);
            }
            if (!textReason) {
              tree.apply(textOnly);
              removedItems += textPlan.removedItems;
              textPlan.satisfied.forEach((satisfied, index) => {
                const cover = textCoverEdits[index];
                // The pictures were not removed here, so a cover naming any keeps its patch.
                if (satisfied && cover && cover.replacesImages === undefined && !cover.replacesShapes?.length && !keepsOldDots(cover)) {
                  satisfiedTextCovers.add(cover);
                }
              });
            }
          } else if (!imageReason && imagePlan) {
            const imageOnly = new Map<string, Uint8Array>();
            for (const key of new Set(imagePlan.rewrites.map((rewrite) => rewrite.streamKey))) {
              const tokens = tree.tokensFor(key);
              const bytes = tokens
                ? rewriteImagePaintOperators(
                    tokens,
                    imagePlan.rewrites.filter((rewrite) => rewrite.streamKey === key),
                  )
                : null;
              if (!bytes) {
                imageReason = 'the rewritten stream failed its round-trip guard';
                break;
              }
              imageOnly.set(key, bytes);
            }
            if (!imageReason) {
              removedImageRefs.push(...tree.apply(imageOnly, imagePlan.removedResources));
              removedImages += imagePlan.removedImages;
            }
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'the page could not be processed safely';
        if (removeText) textReason = reason;
        if (removeImages) imageReason = reason;
        if (removeShapes) shapeReason = reason;
      }
      if (textReason) {
        skippedPages += 1;
        warnings.push(
          `Old text on page ${pageIndex + 1} could not be removed; it stays hidden under the cover. (${textReason})`,
        );
      }
      if (imageReason) {
        imageSkippedPages += 1;
        warnings.push(
          `Old images on page ${pageIndex + 1} could not be removed; they stay hidden under the cover. (${imageReason})`,
        );
      }
      if (shapeReason) warnings.push(`Old drawn bullets on page ${pageIndex + 1} could not be removed; they stay hidden under the cover. (${shapeReason})`);
    }
  } finally {
    if (!sharedReader) await reader?.destroy();
  }
  deleteUnreachableImageObjects(pdf, removedImageRefs);
  return {
    removedItems,
    skippedPages,
    removedImages,
    unmatchedImages,
    outsideCoverImages,
    imageSkippedPages,
    ...(shapePages.length ? { removedShapes, unmatchedShapes } : {}),
  };
}

/** Load pristine bytes, dispatch PDF-point edits in z-order, and serialize once. */
export async function exportPdf(
  doc: EditDocument,
  internal: PageWritingOptions = {},
): Promise<ExportResult> {
  const source = await PDFDocument.load(doc.originalBytes, { updateMetadata: false });
  const identityPlan = isIdentityPagePlan(doc.plan, source.getPageCount());
  const pdf = identityPlan ? source : await PDFDocument.create({ updateMetadata: false });
  if (!identityPlan) {
    const plan = doc.plan;
    invariant(plan, 'a structural export requires a page plan');
    for (const entry of plan) {
      if (entry.kind === 'blank') {
        pdf.addPage([entry.widthPt, entry.heightPt]);
        continue;
      }
      invariant(
        Number.isInteger(entry.sourceIndex)
          && entry.sourceIndex >= 0
          && entry.sourceIndex < source.getPageCount(),
        `invalid source page index ${entry.sourceIndex}`,
      );
      const [copied] = await pdf.copyPages(source, [entry.sourceIndex]);
      invariant(copied, `failed to copy source page ${entry.sourceIndex}`);
      pdf.addPage(copied);
    }
  }
  const written = await writePageEdits(pdf, doc, internal);
  return { bytes: await pdf.save(), warnings: written.warnings, redaction: written.redaction };
}

/** The full export and ephemeral one-page preview share removal and every drawing handler. */
export async function writePageEdits(
  pdf: PDFDocument,
  doc: EditDocument,
  internal: PageWritingOptions = {},
) {
  const editsByPage = groupBy(doc.edits, (edit) => edit.pageIndex);
  const warnings: string[] = [];
  const satisfiedTextCovers = new Set<CoverEdit>();
  const redaction = await removeCoveredContent(
    pdf,
    doc,
    editsByPage,
    warnings,
    satisfiedTextCovers,
    internal.removeCoveredText ?? REMOVE_COVERED_TEXT,
    internal.removeCoveredImages ?? REMOVE_COVERED_IMAGES,
    internal.reader,
    internal.removeCoveredShapes ?? true,
  );

  for (const [pageIndex, pageEdits] of editsByPage) {
    invariant(Number.isInteger(pageIndex), `page index must be an integer: ${pageIndex}`);
    invariant(pageIndex >= 0 && pageIndex < pdf.getPageCount(), `invalid page index ${pageIndex}`);

    const geometry = doc.pages[pageIndex];
    invariant(geometry, `missing geometry for page ${pageIndex}`);
    invariant(geometry.pageIndex === pageIndex, `geometry index mismatch for page ${pageIndex}`);

    const page = pdf.getPage(pageIndex);
    const context = makePageContext({ pdf, page, geometry, doc, warnings });
    const sortedEdits = pageEdits
      .filter((edit) => !(edit.kind === 'cover' && satisfiedTextCovers.has(edit)))
      .filter((edit) => !(edit.kind === 'text' && internal.omitTextIds?.has(edit.id)))
      .sort((left, right) => left.z - right.z);

    for (const edit of sortedEdits) {
      const handler = HANDLERS[edit.kind] as EditHandler;
      await handler(edit, context);
    }
  }

  return {
    warnings,
    redaction,
    satisfiedCoverIds: new Set([...satisfiedTextCovers].map((cover) => cover.id)),
  };
}
