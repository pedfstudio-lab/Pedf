import type { PDFPageProxy } from 'pdfjs-dist';
import type { PagePreviewRequest } from '@/lib/export/exportPagePreview';
import type { Edit } from '@/lib/export/types';
import type { LoadedDocument } from '@/lib/pdf/loadDocument';
import { acquirePagePreviewService } from '@/lib/pdf/pagePreviewService';
import { pdfjs } from '@/lib/pdf/worker';

export interface CleanPage { readonly page: PDFPageProxy; destroy(): Promise<void> }

/** The page copies the translation draws on, kept while the PDF is open. */
export const CLEAN_PAGE_LIMIT = 4;

/**
 * A page with its English removed is the same at every zoom and in every language, so it is
 * made once and only redrawn. The opened copy keeps its decoded pictures, which is what makes
 * the redraw quick; only the most recently used few are kept for that reason.
 */
export class CleanPageCache {
  private readonly entries = new Map<string, Promise<CleanPage>>();
  constructor(private readonly limit = CLEAN_PAGE_LIMIT) {}

  async get(key: string, create: () => Promise<CleanPage>): Promise<PDFPageProxy> {
    let entry = this.entries.get(key);
    if (entry) this.entries.delete(key);
    else {
      const created = create();
      created.catch(() => { if (this.entries.get(key) === created) this.entries.delete(key); });
      entry = created;
    }
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) {
      const [oldest, evicted] = this.entries.entries().next().value as [string, Promise<CleanPage>];
      this.entries.delete(oldest);
      void evicted.then(clean => clean.destroy(), () => undefined);
    }
    return (await entry).page;
  }

  clear(): void {
    for (const entry of this.entries.values()) void entry.then(clean => clean.destroy(), () => undefined);
    this.entries.clear();
  }
}

export async function openCleanPage(loaded: LoadedDocument, request: PagePreviewRequest): Promise<CleanPage> {
  const acquired = acquirePagePreviewService(loaded);
  try {
    const result = await acquired.service.export(request);
    if (!result.clean) throw new Error('The original text could not be hidden safely.');
    const loading = pdfjs.getDocument({ data: result.bytes.slice(), fontExtraProperties: true });
    try {
      const reader = await loading.promise;
      return { page: await reader.getPage(1), destroy: () => loading.destroy() };
    } catch (error) { await loading.destroy(); throw error; }
  } finally { acquired.release(); }
}

const identities = new WeakMap<Edit, number>();
let nextIdentity = 0;
/** Edits are replaced, never mutated, so object identity names an edit's exact content. */
export function editsIdentity(edits: readonly Edit[]): string {
  return edits.map(edit => {
    let id = identities.get(edit);
    if (id === undefined) { id = ++nextIdentity; identities.set(edit, id); }
    return id;
  }).join(',');
}
