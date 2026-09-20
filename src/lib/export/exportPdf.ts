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

const REMOVE_COVERED_TEXT = true;

interface InternalExportOptions {
  readonly removeCoveredText?: boolean;
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

async function removeCoveredText(
  pdf: PDFDocument,
  doc: EditDocument,
  editsByPage: Map<number, EditDocument['edits']>,
  warnings: string[],
  enabled: boolean,
): Promise<ExportRedactionResult> {
  const coverPages = [...editsByPage.entries()].flatMap(([pageIndex, edits]) => (
    edits.some((edit) => edit.kind === 'cover') ? [pageIndex] : []
  ));
  if (!enabled || coverPages.length === 0) return { removedItems: 0, skippedPages: 0 };
  if (pdf.context.trailerInfo.Encrypt) {
    for (const pageIndex of coverPages) {
      warnings.push(`Old text on page ${pageIndex + 1} could not be removed; it stays hidden under the cover.`);
    }
    return { removedItems: 0, skippedPages: coverPages.length };
  }

  const eligiblePages = coverPages;
  let skippedPages = 0;

  let reader: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | undefined;
  let removedItems = 0;
  try {
    reader = await readForRedaction(doc.originalBytes);
  } catch {
    for (const pageIndex of eligiblePages) {
      warnings.push(`Old text on page ${pageIndex + 1} could not be removed; it stays hidden under the cover.`);
    }
    return { removedItems: 0, skippedPages: skippedPages + eligiblePages.length };
  }

  try {
    for (const pageIndex of eligiblePages) {
      let reason: string | undefined;
      try {
      const tree = buildPageStreamTree(pdf, pageIndex);
      const originalPageIndex = sourcePageIndex(doc, pageIndex);
      const covers = (editsByPage.get(pageIndex) ?? []).flatMap((edit) => (
        edit.kind === 'cover' ? [{ rect: edit.rect, replaces: edit.replaces }] : []
      ));
      if (!tree) reason = 'the content streams could not be decoded';
      else if (originalPageIndex === null || originalPageIndex < 0 || originalPageIndex >= reader.numPages) {
        reason = 'the page has no original text source';
      } else {
        const sourcePage = await reader.getPage(originalPageIndex + 1);
        const content = await sourcePage.getTextContent();
        // 0 = AnnotationMode.DISABLE: form-field appearances are separate
        // objects that getTextContent never reports, so including them would
        // make the operator counts differ and skip the page.
        const operatorList = await sourcePage.getOperatorList({ annotationMode: 0 });
        const plan = planCoveredGlyphRemoval(
          content.items,
          operatorList,
          sourcePage.getViewport({ scale: 1, rotation: 0 }),
          tree.roots,
          covers,
        );
        if (plan.skipped) reason = plan.reason ?? 'the page could not be mapped safely';
        else {
          const rewritten = new Map<string, Uint8Array>();
          for (const key of new Set(plan.rewrites.map((rewrite) => rewrite.streamKey))) {
            // The walk resolved every touched stream, page or form, already.
            const tokens = tree.tokensFor(key);
            const bytes = tokens
              ? rewriteStream(tokens, plan.rewrites.filter((rewrite) => rewrite.streamKey === key))
              : null;
            if (!bytes) {
              reason = 'the rewritten stream failed its round-trip guard';
              break;
            }
            rewritten.set(key, bytes);
          }
          if (!reason) {
            tree.apply(rewritten);
            removedItems += plan.removedItems;
          }
        }
      }
      } catch (error) {
        reason = error instanceof Error ? error.message : 'the page could not be processed safely';
      }
      if (reason) {
        skippedPages += 1;
        warnings.push(
          `Old text on page ${pageIndex + 1} could not be removed; it stays hidden under the cover. (${reason})`,
        );
      }
    }
  } finally {
    await reader?.destroy();
  }
  return { removedItems, skippedPages };
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
  const redaction = await removeCoveredText(
    pdf,
    doc,
    editsByPage,
    warnings,
    internal.removeCoveredText ?? REMOVE_COVERED_TEXT,
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
