import { PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { pdfjs } from '@/lib/pdf/worker';
import { writePageEdits } from './exportPdf';
import type { CoverEdit, Edit, EditDocument } from './types';

export interface PagePreviewSelection {
  readonly key: string;
  readonly transientEdits: readonly CoverEdit[];
  readonly omitTextIds: readonly string[];
  readonly coverIds: readonly string[];
  readonly paintSupported: boolean;
  readonly unsafeReason?: string;
}

export interface PagePreviewRequest {
  readonly document: EditDocument;
  readonly pageIndex: number;
  readonly selection?: PagePreviewSelection;
}

export interface PagePreviewResult {
  readonly bytes: Uint8Array;
  readonly clean: boolean;
  readonly reason?: string;
  readonly warnings: readonly string[];
  readonly renderedEditIds: ReadonlySet<string>;
  readonly satisfiedCoverIds: ReadonlySet<string>;
  readonly timings: { readonly sourceMs: number; readonly rewriteMs: number };
}

/** Owns only pristine parsed resources. No edited PDF, draft or history is cached here. */
export class PagePreviewSource {
  private parsed?: Promise<PDFDocument>;
  private readerPromise?: Promise<PDFDocumentProxy>;
  private disposed = false;

  constructor(readonly bytes: Uint8Array, private readonly sharedReader?: PDFDocumentProxy) {}

  async prepare(sourceIndex?: number): Promise<{ pdf: PDFDocument; reader: PDFDocumentProxy }> {
    if (this.disposed) throw new Error('Preview source was released.');
    this.parsed ??= PDFDocument.load(this.bytes, { updateMetadata: false });
    this.readerPromise ??= this.sharedReader ? Promise.resolve(this.sharedReader) : this.openReader();
    const [pdf, reader] = await Promise.all([this.parsed, this.readerPromise]);
    if (this.disposed) throw new Error('Preview source was released.');
    if (sourceIndex !== undefined) {
      const page = await reader.getPage(sourceIndex + 1);
      await Promise.all([page.getOperatorList({ annotationMode: 0 }), page.getTextContent()]);
    }
    return { pdf, reader };
  }

  private async openReader(): Promise<PDFDocumentProxy> {
    if (typeof process !== 'undefined' && process.versions?.node) {
      const specifier = 'pdfjs-dist/legacy/build/pdf.mjs';
      const legacy = await import(/* @vite-ignore */ specifier) as typeof pdfjs;
      return legacy.getDocument({ data: this.bytes.slice(), fontExtraProperties: true, verbosity: 0 }).promise;
    }
    return pdfjs.getDocument({ data: this.bytes.slice(), fontExtraProperties: true }).promise;
  }

  dispose(): void {
    this.disposed = true;
    if (!this.sharedReader) void this.readerPromise?.then((reader) => reader.destroy()).catch(() => undefined);
    this.parsed = undefined;
  }
}

/** One live page, with precisely the removal, fonts and handlers used by the downloaded PDF. */
export async function exportPagePreview(
  request: PagePreviewRequest,
  sharedSource?: PagePreviewSource,
): Promise<PagePreviewResult> {
  const { document, pageIndex, selection } = request;
  const geometry = document.pages[pageIndex];
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || !geometry) throw new RangeError('Invalid preview page.');
  const entry = document.plan?.[pageIndex] ?? { id: `source-${pageIndex}`, kind: 'source' as const, sourceIndex: pageIndex };
  const source = sharedSource ?? new PagePreviewSource(document.originalBytes);
  const started = performance.now();
  try {
    const { pdf: original, reader } = await source.prepare(entry.kind === 'source' ? entry.sourceIndex : undefined);
    const sourceMs = performance.now() - started;
    const pdf = await PDFDocument.create({ updateMetadata: false });
    if (entry.kind === 'source') {
      const [copied] = await pdf.copyPages(original, [entry.sourceIndex]);
      if (!copied) throw new Error('The source page could not be copied.');
      pdf.addPage(copied);
    } else pdf.addPage([entry.widthPt, entry.heightPt]);

    const pageEdits = document.edits.filter((edit) => edit.pageIndex === pageIndex);
    const transient = selection?.transientEdits ?? [];
    const edits: Edit[] = [...pageEdits, ...transient].map((edit) => ({ ...edit, pageIndex: 0 }));
    const written = await writePageEdits(pdf, {
      originalBytes: document.originalBytes,
      plan: [entry],
      pages: [{ ...geometry, pageIndex: 0 }],
      edits,
      ...(document.sampleBackground ? {
        sampleBackground: (_index: number, rect: import('./types').PdfRect) => document.sampleBackground!(pageIndex, rect),
      } : {}),
    }, { reader, omitTextIds: new Set(selection?.omitTextIds) });
    let reason: string | undefined;
    if (selection) {
      if (selection.unsafeReason) reason = selection.unsafeReason;
      else if (!selection.paintSupported) reason = 'The source text paint cannot be represented safely.';
      else if (selection.coverIds.length === 0) reason = 'The selection has no removable source text.';
      else if ([...pageEdits, ...transient].some((edit) => (
        edit.kind === 'cover' && selection.coverIds.includes(edit.id) && edit.replacesImages !== undefined
      ))) reason = 'The selected cover also replaces an image.';
      else if (selection.coverIds.some((id) => !written.satisfiedCoverIds.has(id))) {
        reason = written.warnings[0] ?? 'Not every selected source glyph could be removed safely.';
      }
    }
    return {
      bytes: await pdf.save(),
      clean: reason === undefined,
      ...(reason ? { reason } : {}),
      warnings: written.warnings,
      renderedEditIds: new Set(pageEdits.filter((edit) => !selection?.omitTextIds.includes(edit.id)).map((edit) => edit.id)),
      satisfiedCoverIds: written.satisfiedCoverIds,
      timings: { sourceMs, rewriteMs: performance.now() - started - sourceMs },
    };
  } finally { if (!sharedSource) source.dispose(); }
}
