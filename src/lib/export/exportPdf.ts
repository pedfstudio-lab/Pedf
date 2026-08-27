import { PDFDocument } from 'pdf-lib';
import { groupBy } from '@/lib/util/groupBy';
import { invariant } from '@/lib/util/assert';
import { isIdentityPagePlan } from '@/state/pagePlan';
import { makePageContext } from './context';
import { HANDLERS } from './registry';
import type { EditHandler } from './registry';
import type { EditDocument } from './types';

export interface ExportResult {
  readonly bytes: Uint8Array;
  readonly warnings: string[];
}

/** Load pristine bytes, dispatch PDF-point edits in z-order, and serialize once. */
export async function exportPdf(doc: EditDocument): Promise<ExportResult> {
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
  const warnings: string[] = [];
  const editsByPage = groupBy(doc.edits, (edit) => edit.pageIndex);

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
  };
}
