import {
  decodePDFRawStream,
  PDFArray,
  PDFContentStream,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFStream,
} from 'pdf-lib';
import { groupBy } from '@/lib/util/groupBy';
import { invariant } from '@/lib/util/assert';
import { isIdentityPagePlan } from '@/state/pagePlan';
import { pdfjs } from '@/lib/pdf/worker';
import { makePageContext } from './context';
import { HANDLERS } from './registry';
import type { EditHandler } from './registry';
import type { EditDocument, ExportRedactionResult, PdfRect } from './types';
import {
  rewriteTextShowOperator,
  serializeContentStream,
  textShowOperators,
  tokenizeContentStream,
} from './contentStream';
import type { ContentToken } from './contentStream';
import { planCoveredGlyphRemoval } from './coveredGlyphs';
import type { CoveredGlyphRewrite } from './coveredGlyphs';

const REMOVE_COVERED_TEXT = true;

interface InternalExportOptions {
  readonly removeCoveredText?: boolean;
}

export interface ExportResult {
  readonly bytes: Uint8Array;
  readonly warnings: string[];
  readonly redaction: ExportRedactionResult;
}

interface PageStreamBinding {
  readonly tokens: readonly ContentToken[];
  replace(bytes: Uint8Array): void;
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

function replacementStream(pdf: PDFDocument, stream: PDFStream, bytes: Uint8Array): PDFRawStream {
  const dictionary = stream.dict.clone(pdf.context);
  dictionary.delete(PDFName.of('Filter'));
  dictionary.delete(PDFName.of('DecodeParms'));
  dictionary.delete(PDFName.Length);
  return PDFRawStream.of(dictionary, bytes);
}

function pageStreamBindings(pdf: PDFDocument, pageIndex: number): PageStreamBinding[] | null {
  const page = pdf.getPage(pageIndex);
  const contents = page.node.Contents();
  if (!contents) return [];
  const streams: Array<{ stream: PDFStream; replace(bytes: Uint8Array): void }> = [];
  if (contents instanceof PDFStream) {
    streams.push({
      stream: contents,
      replace(bytes) {
        const ref = pdf.context.register(replacementStream(pdf, contents, bytes));
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
          contents.set(index, pdf.context.register(replacementStream(pdf, stream, bytes)));
        },
      });
    }
  }
  const bindings: PageStreamBinding[] = [];
  for (const binding of streams) {
    const bytes = decodedStream(binding.stream);
    if (!bytes) return null;
    try {
      bindings.push({ tokens: tokenizeContentStream(bytes), replace: binding.replace });
    } catch {
      return null;
    }
  }
  return bindings;
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

function pageHasFormXObject(pdf: PDFDocument, pageIndex: number): boolean {
  const resources = pdf.getPage(pageIndex).node.Resources();
  const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xObjects) return false;
  return xObjects.entries().some(([name]) => {
    const stream = xObjects.lookupMaybe(name, PDFStream);
    return stream?.dict.get(PDFName.of('Subtype')) === PDFName.of('Form');
  });
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

  const eligiblePages: number[] = [];
  let skippedPages = 0;
  for (const pageIndex of coverPages) {
    if (pageHasFormXObject(pdf, pageIndex)) {
      skippedPages += 1;
      warnings.push(
        `Old text on page ${pageIndex + 1} could not be removed; it stays hidden under the cover. (the page contains a Form XObject)`,
      );
    } else eligiblePages.push(pageIndex);
  }
  if (eligiblePages.length === 0) return { removedItems: 0, skippedPages };

  let reader: Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> | undefined;
  let removedItems = 0;
  try {
    reader = await pdfjs.getDocument({
      data: doc.originalBytes.slice(),
      fontExtraProperties: true,
    }).promise;
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
      const bindings = pageStreamBindings(pdf, pageIndex);
      const originalPageIndex = sourcePageIndex(doc, pageIndex);
      const covers = (editsByPage.get(pageIndex) ?? []).flatMap((edit) => (
        edit.kind === 'cover' ? [edit.rect as PdfRect] : []
      ));
      if (!bindings) reason = 'the content streams could not be decoded';
      else if (originalPageIndex === null || originalPageIndex < 0 || originalPageIndex >= reader.numPages) {
        reason = 'the page has no original text source';
      } else {
        const sourcePage = await reader.getPage(originalPageIndex + 1);
        const content = await sourcePage.getTextContent();
        const operatorList = await sourcePage.getOperatorList();
        const plan = planCoveredGlyphRemoval(
          content.items,
          operatorList,
          sourcePage.getViewport({ scale: 1, rotation: 0 }),
          bindings.map(({ tokens }) => tokens),
          covers,
        );
        if (plan.skipped) reason = plan.reason ?? 'the page could not be mapped safely';
        else {
          const candidates = bindings.flatMap((binding, streamIndex) => {
            const rewrites = plan.rewrites.filter((rewrite) => rewrite.streamIndex === streamIndex);
            if (rewrites.length === 0) return [];
            return [{ binding, bytes: rewriteStream(binding.tokens, rewrites) }];
          });
          if (candidates.some((candidate) => candidate.bytes === null)) {
            reason = 'the rewritten stream failed its round-trip guard';
          }
          else {
            for (const candidate of candidates) {
              if (candidate.bytes) candidate.binding.replace(candidate.bytes);
            }
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
