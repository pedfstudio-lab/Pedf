import type { PDFDocumentProxy } from 'pdfjs-dist';
import { extractTextRuns, mergeRunsIntoLines } from './textContent';

/** Maximum amount of marked document text sent downstream in the v1 flow. */
export const DOCUMENT_TEXT_CHAR_LIMIT = 50_000;
export const DOCUMENT_TRUNCATED_MARKER = '\n[…document truncated…]';

export interface DocumentText {
  /** Clean, untruncated text for each page; index 0 is PDF page 1. */
  readonly pages: readonly string[];
  /** Page-marked document text, capped by DOCUMENT_TEXT_CHAR_LIMIT. */
  readonly full: string;
  /** Length of the complete page-marked text before any truncation. */
  readonly charCount: number;
}

const documentTextCache = new WeakMap<PDFDocumentProxy, Promise<DocumentText>>();

function pageSection(text: string, pageIndex: number): string {
  const marker = `[Page ${pageIndex + 1}]`;
  return text ? `${marker}\n${text}` : marker;
}

/**
 * Build deterministic, page-marked context from already-extracted page text.
 * Kept public so the size guard can be tested without manufacturing a huge PDF.
 */
export function buildDocumentText(
  pages: readonly string[],
  maxChars = DOCUMENT_TEXT_CHAR_LIMIT,
): DocumentText {
  if (!Number.isInteger(maxChars) || maxChars < DOCUMENT_TRUNCATED_MARKER.length) {
    throw new RangeError(
      `maxChars must be an integer of at least ${DOCUMENT_TRUNCATED_MARKER.length}`,
    );
  }

  const cleanPages = pages.map((page) => page.trim());
  const complete = cleanPages.map(pageSection).join('\n\n');
  const full = complete.length <= maxChars
    ? complete
    : complete.slice(0, maxChars - DOCUMENT_TRUNCATED_MARKER.length).trimEnd() +
      DOCUMENT_TRUNCATED_MARKER;

  return {
    pages: cleanPages,
    full,
    charCount: complete.length,
  };
}

/** Extract every page's real PDF text in reading order. */
export async function extractDocumentText(doc: PDFDocumentProxy): Promise<DocumentText> {
  const pages: string[] = [];
  for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex += 1) {
    const page = await doc.getPage(pageIndex + 1);
    const runs = await extractTextRuns(page, pageIndex);
    const text = mergeRunsIntoLines(runs)
      .map((line) => line.text)
      .join('\n');
    pages.push(text);
  }
  return buildDocumentText(pages);
}

/** Return the single shared extraction promise for this loaded PDF document. */
export function getDocumentText(doc: PDFDocumentProxy): Promise<DocumentText> {
  const cached = documentTextCache.get(doc);
  if (cached) return cached;

  const pending = extractDocumentText(doc);
  documentTextCache.set(doc, pending);
  // A failed read may be retried instead of permanently caching a rejection.
  void pending.catch(() => {
    if (documentTextCache.get(doc) === pending) documentTextCache.delete(doc);
  });
  return pending;
}
