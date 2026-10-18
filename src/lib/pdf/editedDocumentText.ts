import type { PDFDocumentProxy } from 'pdfjs-dist';
import { itemMatchesCover } from '@/lib/export/coveredGlyphs';
import type { TextRemovalCover } from '@/lib/export/coveredGlyphs';
import type { CoverEdit, Edit, TextEdit } from '@/lib/export/types';
import { isIdentityPagePlan } from '@/state/pagePlan';
import type { PagePlan } from '@/state/pagePlan';
import { buildDocumentText, getDocumentText } from './documentText';
import type { DocumentText } from './documentText';
import { extractTextRuns, mergeRunsIntoLines } from './textContent';
import type { TextRun } from './textContent';

// The ordinary extraction already caches page strings. Keep geometry only for
// pages Ask needs to rebuild, including when another live page duplicates one.
const sourceRuns = new WeakMap<PDFDocumentProxy, Map<number, Promise<readonly TextRun[]>>>();

function getSourceRuns(doc: PDFDocumentProxy, sourceIndex: number): Promise<readonly TextRun[]> {
  let pages = sourceRuns.get(doc);
  if (!pages) {
    pages = new Map();
    sourceRuns.set(doc, pages);
  }
  const cached = pages.get(sourceIndex);
  if (cached) return cached;
  const pending = doc.getPage(sourceIndex + 1).then(page => extractTextRuns(page, sourceIndex));
  pages.set(sourceIndex, pending);
  void pending.catch(() => {
    if (pages.get(sourceIndex) === pending) pages.delete(sourceIndex);
  });
  return pending;
}

function removesText(edit: Edit): edit is CoverEdit {
  // Match the edit model's removal intent, not a photo's bounding rectangle.
  return edit.kind === 'cover'
    && ((edit.replacesImages === undefined && edit.replacesShapes === undefined)
      || (edit.replaces?.length ?? 0) > 0);
}

function rebuildPage(runs: readonly TextRun[], edits: readonly Edit[], pageIndex: number): string {
  const covers = edits.filter(removesText);
  const texts = edits.filter((edit): edit is TextEdit => edit.kind === 'text');
  const removals: TextRemovalCover[] = [...covers];
  // Position-fidelity edits can leave unchanged source words painted in the PDF
  // while their TextEdit.text still describes the WHOLE saved line. Suppress
  // those source copies in chat too, or Ask reads each unchanged word twice.
  for (const text of texts) {
    const retained = text.composition?.pieces.flatMap(piece => (
      piece.sourceVisible && piece.sourceRect ? [{ text: piece.text, rect: piece.sourceRect }] : []
    )) ?? [];
    if (retained.length) removals.push({ rect: text.rect, replaces: retained });
  }
  const visible: TextRun[] = [];
  for (const line of mergeRunsIntoLines(runs)) {
    let fragment: TextRun[] = [];
    const flush = () => {
      for (const part of mergeRunsIntoLines(fragment)) {
        visible.push({ pageIndex, text: part.text, rect: part.rect, style: part.style });
      }
      fragment = [];
    };
    for (const run of line.runs) {
      if (itemMatchesCover(run.text, run.rect, removals)) flush();
      else fragment.push(run);
    }
    flush();
  }
  for (const text of texts) {
    // A later legacy whiteout may hide placed text as well as source text.
    const laterWhiteouts = covers.filter(cover => cover.replaces === undefined && cover.z > text.z);
    if (!text.text.trim() || itemMatchesCover(text.text, text.rect, laterWhiteouts)) continue;
    visible.push({ pageIndex, text: text.text, rect: text.rect, style: text.style });
  }
  // Reuse the original reading-order rules, not the editor box width as an ink
  // measurement. A saved box can span a whole column; inferring spaces from its
  // right edge would turn "7,500 including tax" into "7,500including tax".
  // Keep intact source fragments / saved edit lines separated as chat text.
  return mergeRunsIntoLines(visible)
    .flatMap(line => line.runs.map(run => run.text.trim()))
    .filter(Boolean)
    .join('\n');
}

/** Ask-only context: the current live page plan and committed edits, never an export. */
export async function getEditedDocumentText(
  doc: PDFDocumentProxy,
  edits: readonly Edit[],
  plan?: PagePlan,
): Promise<DocumentText> {
  const original = await getDocumentText(doc);
  const byPage = new Map<number, Edit[]>();
  for (const edit of edits) {
    if (edit.kind !== 'text' && !removesText(edit)) continue;
    const pageEdits = byPage.get(edit.pageIndex) ?? [];
    pageEdits.push(edit);
    byPage.set(edit.pageIndex, pageEdits);
  }
  // Keep the exact shared result (including truncation/markers) on the common path.
  if (byPage.size === 0 && isIdentityPagePlan(plan, doc.numPages)) return original;

  const livePages = plan ?? Array.from({ length: doc.numPages }, (_, sourceIndex) => (
    { kind: 'source' as const, sourceIndex }
  ));
  const pages: string[] = [];
  for (const [pageIndex, entry] of livePages.entries()) {
    const pageEdits = byPage.get(pageIndex);
    if (!pageEdits?.length) {
      pages.push(entry.kind === 'source' ? original.pages[entry.sourceIndex] ?? '' : '');
      continue;
    }
    const runs = entry.kind === 'source' ? await getSourceRuns(doc, entry.sourceIndex) : [];
    pages.push(rebuildPage(runs, pageEdits, pageIndex));
  }
  return buildDocumentText(pages);
}
