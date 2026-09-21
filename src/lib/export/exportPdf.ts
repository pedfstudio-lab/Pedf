import { PDFDocument } from 'pdf-lib';
import { groupBy } from '@/lib/util/groupBy';
import { invariant } from '@/lib/util/assert';
import { isIdentityPagePlan } from '@/state/pagePlan';
import { pdfjs } from '@/lib/pdf/worker';
import { makePageContext } from './context';
import { HANDLERS } from './registry';
import type { EditHandler } from './registry';
import type { EditDocument, ExportRedactionResult } from './types';
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

const REMOVE_COVERED_TEXT = true;
const REMOVE_COVERED_IMAGES = true;

interface InternalExportOptions {
  readonly removeCoveredText?: boolean;
  readonly removeCoveredImages?: boolean;
}

function rewriteCombinedStream(
  original: readonly ContentToken[],
  imageRewrites: readonly CoveredImageRewrite[],
  textRewrites: readonly CoveredGlyphRewrite[],
): Uint8Array | null {
  const imageBytes = imageRewrites.length > 0
    ? rewriteImagePaintOperators(original, imageRewrites)
    : serializeContentStream(original);
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

async function removeCoveredContent(
  pdf: PDFDocument,
  doc: EditDocument,
  editsByPage: Map<number, EditDocument['edits']>,
  warnings: string[],
  textEnabled: boolean,
  imagesEnabled: boolean,
): Promise<ExportRedactionResult> {
  const textPages = [...editsByPage.entries()].flatMap(([pageIndex, edits]) => (
    edits.some((edit) => edit.kind === 'cover' && edit.replacesImages === undefined) ? [pageIndex] : []
  ));
  const imagePages = [...editsByPage.entries()].flatMap(([pageIndex, edits]) => (
    edits.some((edit) => edit.kind === 'cover' && (edit.replacesImages?.length ?? 0) > 0)
      ? [pageIndex]
      : []
  ));
  const eligibleTextPages = textEnabled ? textPages : [];
  const eligibleImagePages = imagesEnabled ? imagePages : [];
  const eligiblePages = [...new Set([...eligibleTextPages, ...eligibleImagePages])];
  const empty = {
    removedItems: 0,
    skippedPages: 0,
    removedImages: 0,
    unmatchedImages: 0,
    outsideCoverImages: 0,
    imageSkippedPages: 0,
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
  const removedImageRefs: PDFRef[] = [];
  try {
    reader = await readForRedaction(doc.originalBytes);
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
      let textReason: string | undefined;
      let imageReason: string | undefined;
      try {
        const tree = buildPageStreamTree(pdf, pageIndex);
        const originalPageIndex = sourcePageIndex(doc, pageIndex);
        if (!tree) {
          if (removeText) textReason = 'the content streams could not be decoded';
          if (removeImages) imageReason = 'the content streams could not be decoded';
        } else if (originalPageIndex === null || originalPageIndex < 0 || originalPageIndex >= reader.numPages) {
          if (removeText) textReason = 'the page has no original text source';
          if (removeImages) imageReason = 'the page has no original image source';
        } else {
          const sourcePage = await reader.getPage(originalPageIndex + 1);
          // 0 = AnnotationMode.DISABLE: form-field appearances are separate objects.
          const operatorList = await sourcePage.getOperatorList({ annotationMode: 0 });
          const viewport = sourcePage.getViewport({ scale: 1, rotation: 0 });
          const pageEdits = editsByPage.get(pageIndex) ?? [];
          const textCovers = pageEdits.flatMap((edit) => (
            edit.kind === 'cover' && edit.replacesImages === undefined
              ? [{ rect: edit.rect, replaces: edit.replaces }]
              : []
          ));
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
          const rewritten = new Map<string, Uint8Array>();
          const streamKeys = new Set([
            ...textRewrites.map((rewrite) => rewrite.streamKey),
            ...imageRewrites.map((rewrite) => rewrite.streamKey),
          ]);
          for (const key of streamKeys) {
            const tokens = tree.tokensFor(key);
            const bytes = tokens ? rewriteCombinedStream(
              tokens,
              imageRewrites.filter((rewrite) => rewrite.streamKey === key),
              textRewrites.filter((rewrite) => rewrite.streamKey === key),
            ) : null;
            if (!bytes) {
              if (textRewrites.some((rewrite) => rewrite.streamKey === key)) {
                textReason = 'the rewritten stream failed its round-trip guard';
              }
              if (imageRewrites.some((rewrite) => rewrite.streamKey === key)) {
                imageReason = 'the rewritten stream failed its round-trip guard';
              }
              break;
            }
            rewritten.set(key, bytes);
          }
          if (!textReason && !imageReason) {
            removedImageRefs.push(...tree.apply(rewritten, imagePlan?.removedResources));
            removedItems += textPlan?.removedItems ?? 0;
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
    }
  } finally {
    await reader?.destroy();
  }
  deleteUnreachableImageObjects(pdf, removedImageRefs);
  return {
    removedItems,
    skippedPages,
    removedImages,
    unmatchedImages,
    outsideCoverImages,
    imageSkippedPages,
  };
}

/** Load pristine bytes, dispatch PDF-point edits in z-order, and serialize once. */
export async function exportPdf(
  doc: EditDocument,
  internal: InternalExportOptions = {},
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
  const editsByPage = groupBy(doc.edits, (edit) => edit.pageIndex);
  const warnings: string[] = [];
  const redaction = await removeCoveredContent(
    pdf,
    doc,
    editsByPage,
    warnings,
    internal.removeCoveredText ?? REMOVE_COVERED_TEXT,
    internal.removeCoveredImages ?? REMOVE_COVERED_IMAGES,
  );

  for (const [pageIndex, pageEdits] of editsByPage) {
    invariant(Number.isInteger(pageIndex), `page index must be an integer: ${pageIndex}`);
    invariant(pageIndex >= 0 && pageIndex < pdf.getPageCount(), `invalid page index ${pageIndex}`);

    const geometry = doc.pages[pageIndex];
    invariant(geometry, `missing geometry for page ${pageIndex}`);
    invariant(geometry.pageIndex === pageIndex, `geometry index mismatch for page ${pageIndex}`);

    const page = pdf.getPage(pageIndex);
    const context = makePageContext({ pdf, page, geometry, doc, warnings });
    const sortedEdits = [...pageEdits].sort((left, right) => left.z - right.z);

    for (const edit of sortedEdits) {
      const handler = HANDLERS[edit.kind] as EditHandler;
      await handler(edit, context);
    }
  }

  return {
    bytes: await pdf.save(),
    warnings,
    redaction,
  };
}
